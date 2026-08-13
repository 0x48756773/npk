const accountDetails = require('./accountDetails.json');

const aws = require('aws-sdk');
const ddb = new aws.DynamoDB({ region: accountDetails.primaryRegion });
const s3 = new aws.S3({ region: accountDetails.primaryRegion });

let cb = "";
let variables = {};

var cognito = new aws.CognitoIdentityServiceProvider({region: accountDetails.primaryRegion, apiVersion: "2016-04-18"});

exports.main = async function(event, context, callback) {

	console.log(JSON.stringify(event));

	// Hand off the callback function for later.
	cb = callback;

	// Get the available envvars into a usable format.
	variables = JSON.parse(JSON.stringify(process.env));

	let entity, UserPoolId, sub;

	try {

		console.log("Received event: " + JSON.stringify(event));

		// Hand off the origin, too. Fix for weird case
		origin = event?.headers?.origin ?? event?.headers?.Origin;

		var allowed_characters = /^[a-zA-Z0-9'"%\.\[\]\{\}\(\)\-\:\\\/\;\=\?\#\_+\s,!@#\$\^\*&]+$/;
		if (!allowed_characters.test(JSON.stringify(event))) {
			console.log("Request contains illegal characters");
			return respond(400, {}, "Request contains illegal characters", false);
		}

		if (event?.requestContext?.identity?.cognitoAuthenticationType != "authenticated") {
			console.log(`cognitoAuthenticationType ${event?.requestContext?.identity?.cognitoAuthenticationType} != "authenticated"`)
			return respond(401, {}, "Authentication Required", false);
		}

		entity = event.requestContext.identity.cognitoIdentityId;

		// Associate the user identity.
		[ UserPoolId,, sub ] = event?.requestContext?.identity?.cognitoAuthenticationProvider?.split('/')[2]?.split(':');

		if (!UserPoolId || !sub) {
			console.log(`UserPoolId or sub is missing from ${event?.requestContext?.identity?.cognitoAuthenticationProvider}`);
			respond(401, {}, "Authorization Required", false);
		}

	} catch (e) {
		console.log("Failed to process request.", e);
		return respond(500, {}, "Failed to process request.", false);
	}

	let user, email, Username;

	try {
		// Get the user based on 'sub'. This is needed when the IdP isn't Cognito itself.
		let userList = await cognito.listUsers({ UserPoolId, Filter: `sub = "${sub}"` }).promise();

		if (!userList.Users?.[0]?.Username) {
			console.log("Unable to find Cognito user from Subscriber ID.", e);
			return respond(500, {}, "Unable to find Cognito user from Subscriber ID.", false);
		}

		Username = userList.Users[0].Username;

		user = await cognito.adminGetUser({ UserPoolId, Username }).promise();

		// Restructure UserAttributes as an k:v
		user.UserAttributes = user.UserAttributes.reduce((attrs, entry) => {
			attrs[entry.Name] = entry.Value

			return attrs;
		}, {});

		if (!user?.UserAttributes?.email) {
			return respond(401, {}, "Unable to obtain user properties.", false);
		}

		email = user.UserAttributes.email;
			
	} catch (e) {
		console.log("Unable to retrieve user context.", e);
		return respond(500, {}, "Unable to retrieve user context.", false);
	}

	const campaignId = event?.pathParameters?.campaign;

	// Get the campaign entry from DynamoDB, and manifest from S3.
	// * In parallel, to save, like, some milliseconds.

	let campaign;

	try {
		campaign = await ddb.query({
			ExpressionAttributeValues: {
				':id': {S: entity},
				':keyid': {S: `campaigns:${campaignId}`}
			},
			KeyConditionExpression: 'userid = :id and keyid = :keyid',
			TableName: "Campaigns"
		}).promise();

		campaign = aws.DynamoDB.Converter.unmarshall(campaign.Items[0]);

	} catch (e) {
		console.log("Failed to retrieve campaign details.", e);
		return respond(500, {}, "Failed to retrieve campaign details.");
	}

	if (!campaign.status) {
		return respond(404, {},  "Specified campaign does not exist.", false);
	}

	// Campaigns created before On-Demand support have no provisioningModel; they're spot.
	const provisioningModel = campaign.provisioningModel ?? "spot";

	console.log(`[+] Campaign ${campaignId} is a '${provisioningModel}' campaign associated with fleet ${campaign.spotFleetRequestId}`);

	var ec2 = new aws.EC2({region: campaign.region});

	// Used on every exit path below, successful or not: once the user has asked for a
	// campaign to stop, it must not remain marked active.
	const markCancelled = () => ddb.updateItem({
		Key: {
			userid: {S: entity},
			keyid: {S: `campaigns:${campaignId}`}
		},
		TableName: "Campaigns",
		AttributeUpdates: {
			active: { Action: 'PUT', Value: { BOOL: false }},
			status: { Action: 'PUT', Value: { S: "CANCELLED" }}
		}
	}).promise();

	switch (campaign.status) {

		// The campaign never launched: it's sitting in the queue waiting for On-Demand
		// capacity, with no fleet and no template to tear down. Marking it cancelled is the
		// whole job - execute_campaign only claims campaigns that are still AWAITING_CAPACITY,
		// so this is also what stops the retries.
		//
		// ACQUIRING_CAPACITY means a retry is mid-flight. It may already hold a reservation,
		// in which case it either parks - and finds this cancellation, because that write is
		// conditional - or completes the launch and records the fleet, which the user can then
		// cancel again. Either way nothing is stranded untracked.
		case "AWAITING_CAPACITY":
		case "ACQUIRING_CAPACITY":

			try {
				await markCancelled();
			} catch(e) {
				console.log("Failed to deactivate campaign.", e);
				return respond(500, {}, "Failed to deactivate campaign.", false);
			}

			return respond(200, {}, "Campaign cancelled while waiting for capacity.", true);

		case "STARTING":
		case "RUNNING":

			if (provisioningModel == "on-demand") {

				let fleet;

				try {
					fleet = await ec2.describeFleets({
						FleetIds: [campaign.spotFleetRequestId]
					}).promise();
				} catch(e) {
					await markCancelled();

					console.log("Failed to retrieve EC2 fleet.", e);
					return respond(500, {}, "Failed to retrieve EC2 fleet.", false);
				}

				if (!fleet.Fleets?.[0]?.FleetId) {
					await markCancelled();

					return respond(404, {}, "Error retrieving EC2 fleet data: not found.", false);
				}

				// Anything not already winding down needs an explicit deletion.
				if (["submitted", "active", "modifying"].indexOf(fleet.Fleets[0].FleetState) > -1) {
					let deletion;

					try {
						deletion = await ec2.deleteFleets({
							FleetIds: [fleet.Fleets[0].FleetId],
							TerminateInstances: true
						}).promise();
					} catch(e) {
						console.log("Failed to request deletion of EC2 fleet.", e);
						return respond(500, {}, "Failed to request deletion of EC2 fleet.", false);
					}

					if (deletion?.UnsuccessfulFleetDeletions?.length > 0) {
						console.log("Error deleting EC2 fleet.", JSON.stringify(deletion.UnsuccessfulFleetDeletions));
						return respond(400, {}, "Error deleting EC2 fleet: " + deletion.UnsuccessfulFleetDeletions[0]?.Error?.Message, false);
					}
				}

				// The per-campaign launch template is dead weight once the fleet is gone.
				await ec2.deleteLaunchTemplate({
					LaunchTemplateName: `npk-${campaignId}`
				}).promise().catch((e) => {
					if (e.code != "InvalidLaunchTemplateName.NotFoundException") {
						console.log(`[-] Unable to delete launch template for campaign ${campaignId}.`, e);
					}
				});

				// Releasing the reserved capacity is the part that actually stops the meter:
				// it bills at the full On-Demand rate until cancelled, however empty it is.
				// The monitor sweeps for this too, but a user who cancels a campaign should
				// not have to wait a minute for the charges to stop.
				if (!!campaign.capacityReservationId && campaign.capacityReservationId != "<none>") {
					await ec2.cancelCapacityReservation({
						CapacityReservationId: campaign.capacityReservationId
					}).promise().then(() => {
						console.log(`[+] Released capacity reservation ${campaign.capacityReservationId}.`);
					}, (e) => {
						console.log(`[-] Unable to release capacity reservation ${campaign.capacityReservationId}.`, e);
					});
				}

			} else {

				let sfr;

				try {
					sfr = await ec2.describeSpotFleetRequests({
						SpotFleetRequestIds: [campaign.spotFleetRequestId]
					}).promise();
				} catch(e) {
					await markCancelled();

					console.log("Failed to retrieve spot fleet request.", e);
					return respond(500, {}, "Failed to retrieve spot fleet request.", false);
				}

				if (!sfr.SpotFleetRequestConfigs?.[0]?.SpotFleetRequestId) {
					await markCancelled();

					return respond(404, {}, "Error retrieving spot fleet data: not found.", false);
				}

				if (sfr.SpotFleetRequestConfigs[0].SpotFleetRequestState == "active") {
					let cancellation;

					try {
						cancellation = await ec2.cancelSpotFleetRequests({
							SpotFleetRequestIds: [sfr.SpotFleetRequestConfigs[0].SpotFleetRequestId],
							TerminateInstances: true
						}).promise();
					} catch(e) {
						console.log("Failed to request cancellation of spot fleet request.", e);
						return respond(500, {}, "Failed to request cancellation of spot fleet request.", false);
					}

					if (cancellation?.SuccessfulFleetRequests?.[0].CurrentSpotFleetRequestState?.indexOf('cancelled') < 0) {
						return respond(400, {}, "Error cancelling spot fleet. Current state: " + cancellation.SuccessfulFleetRequests[0].CurrentSpotFleetRequestState, false);
					}
				}
			}

			try {
				await markCancelled();
			} catch(e) {
				console.log("Failed to deactivate campaign.", e);
				return respond(500, {}, "Failed to deactivate campaign.", false);
			}

			return respond(200, {}, `Campaign ${campaignId} stopped.`, true);

		break;

		default:

			let entries;

			try {
				entries = await ddb.query({
					ExpressionAttributeValues: {
						':id': {S: entity},
						':keyid': {S: `${campaignId}:`}
					},
					KeyConditionExpression: 'userid = :id and begins_with(keyid, :keyid)',
					TableName: "Campaigns"
				}).promise();
			} catch (e) {
				console.log("Failed to retrieve events for campaign.", e);
				return respond(500, {}, "Failed to retrieve events for campaign.", false);
			}

			try {

				// Delete event entries for the campaign.
				const promises = entries.Items.map((entry) => {
					entry = aws.DynamoDB.Converter.unmarshall(entry);

					return ddb.deleteItem({
						Key: {
							userid: {S: entity},
							keyid: {S: entry.keyid}
						},
						TableName: "Campaigns"
					}).promise();
				});

				promises.push(ddb.updateItem({
					Key: {
						userid: {S: entity},
						keyid: {S: `campaigns:${campaignId}`}
					},
					TableName: "Campaigns",
					AttributeUpdates: {
						deleted: { Action: 'PUT', Value: { BOOL: true }}
					}
				}).promise());

				let finished = await Promise.all(promises);

			} catch (e) {
				console.log("Failed to delete campaign", e);
				return respond(500, {}, "Failed to delete campaign", false);
			}

			return respond(200, {}, `Campaign ${campaignId} deleted.`, true);

		break;
	}
}

function respond(statusCode, headers, body, success) {

	// Include terraform dns names as allowed origins, as well as localhost.
	const allowed_origins = [variables.www_dns_names, "https://localhost"];

	headers['Content-Type'] = 'text/plain';

	if (allowed_origins.indexOf(origin) !== false) {
		// Echo the origin back. I guess this is the best way to support multiple origins
		headers['Access-Control-Allow-Origin'] = origin;
	} else {
		console.log("Invalid origin received.", origin);
	}

	switch (typeof body) {
		case "string":
			body = { msg: body, success: success };
		break;

		case "object":
			body.success = success;
		break;
	}

	const response = {
		statusCode: statusCode,
		headers: headers,
		body: JSON.stringify(body),
	}

	console.log(JSON.stringify(response));

	cb(null, response);

	return Promise.resolve(body.msg);
}