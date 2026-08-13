'use strict';

const fs = require('fs');
const aws = require('aws-sdk');

const accountDetails = JSON.parse(fs.readFileSync('./accountDetails.json', 'ascii'));
const archs = Object.keys(accountDetails.families).reduce((acc, curr) => {
	Object.keys(accountDetails.families[curr].instances).forEach((instance) => {
		acc[instance] = accountDetails.families[curr].architecture || "x86_64";
	});

	return acc;
}, {});

const amis = Object.keys(accountDetails.families).reduce((acc, curr) => {
	Object.keys(accountDetails.families[curr].instances).forEach((instance) => {
		acc[instance] = accountDetails.families[curr].ami || false;
	});

	return acc;
}, {});

const owners = Object.keys(accountDetails.families).reduce((acc, curr) => {
	Object.keys(accountDetails.families[curr].instances).forEach((instance) => {
		acc[instance] = accountDetails.families[curr].owner || false;
	});

	return acc;
}, {});

const ddb = new aws.DynamoDB({ region: accountDetails.primaryRegion });
const s3 = new aws.S3({ region: accountDetails.primaryRegion });

// How long a campaign may sit waiting for On-Demand capacity before it gives up. Waiting is
// free - a refused reservation costs nothing - so this is generous, and exists mainly so a
// campaign nobody is watching can't stay queued indefinitely.
const CAPACITY_WAIT_MAX_MS = 6 * 60 * 60 * 1000;

// Every parked campaign carries this in place of a fleet ID, so spot_monitor can find them
// all with one query against the existing 'SpotFleetRequests' index rather than scanning the
// table. It is replaced by the real fleet ID the moment the campaign launches.
const AWAITING_CAPACITY_KEY = "awaiting-capacity";

// How long one retry may hold a campaign before another is allowed to take it over. Longer
// than this function's own 60 second timeout, so a still-running retry is never displaced,
// and short enough that an invocation killed mid-flight doesn't strand the campaign.
const CAPACITY_CLAIM_LEASE_MS = 5 * 60 * 1000;

let cb = "";
let origin = "";
let variables = {};

const cognito = new aws.CognitoIdentityServiceProvider({region: accountDetails.primaryRegion, apiVersion: "2016-04-18"});

exports.main = async function(event, context, callback) {

	console.log(JSON.stringify(event));

	// Hand off the callback function for later.
	cb = callback;

	// Get the available envvars into a usable format.
	variables = JSON.parse(JSON.stringify(process.env));
	variables.regions = JSON.parse(variables.regions);

	let promises = [];

	// Enumerate the subnets based on VPCs per region.
	try {
		variables.availabilityZones = {};

		for (const region of Object.keys(variables.regions)) {

			variables.availabilityZones[region] = {};

			const ec2 = new aws.EC2({region: region});

			promises.push(ec2.describeSubnets({
				Filters: [{
					Name: "vpc-id",
					Values: [variables.regions[region]]
				}]
			}).promise().then((data) => {
				data.Subnets.forEach((subnet) => {
					variables.availabilityZones[region][subnet.AvailabilityZone] = subnet.SubnetId;
				});
			}));
		}

		// Everything downstream builds launch targets out of this map. Without the await it
		// was only populated by luck, via the unrelated awaits that happen to follow.
		await Promise.all(promises);
	} catch (e) {
		console.log(e);
		return callback(`[!] Failed to retrieve subnets for VPC: ${e}`);
	}

	// spot_monitor re-invokes this function for campaigns parked waiting on capacity. That
	// path carries no API Gateway request context and no user credentials: the campaign was
	// authorised when the user started it, and nothing about it can be changed from here, so
	// identity comes from the event itself rather than from Cognito.
	const retryingCapacity = event?.internal?.reason == "capacity-retry";

	let entity, UserPoolId, sub, campaignId;

	if (retryingCapacity) {

		entity = event.internal.userid;
		campaignId = event.internal.campaignId;

		if (!entity || !campaignId) {
			console.log("Internal invocation is missing userid or campaignId.", JSON.stringify(event));
			return respond(400, {}, "Internal invocation is missing userid or campaignId.", false);
		}

		console.log(`[*] Retrying capacity acquisition for campaign ${campaignId}.`);

	} else {

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

		const user = await cognito.adminGetUser({ UserPoolId, Username }).promise();

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
		console.log(`Failed to retrieve subnets for VPC: ${e}`);
		return respond(500, {}, "Failed to retrieve subnets for VPC.", false);
	}

	console.log(event.pathParameters)

	campaignId = event?.pathParameters?.campaign;

	}

	// Get the campaign entry from DynamoDB, and manifest from S3.
	// * In parallel, to save, like, some milliseconds.

	let campaign, manifestObject, manifest;

	try {
		[campaign, manifestObject] = await Promise.all([
			ddb.query({
				ExpressionAttributeValues: {
					':id': {S: entity},
					':keyid': {S: `campaigns:${campaignId}`}
				},
				KeyConditionExpression: 'userid = :id and keyid = :keyid',
				TableName: "Campaigns"
			}).promise(),

			s3.getObject({
				Bucket: variables.userdata_bucket,
				Key: `${entity}/campaigns/${campaignId}/manifest.json`
			}).promise()
		]);

		manifest = JSON.parse(manifestObject.Body.toString('ascii'));
	} catch (e) {
		console.log("Failed to retrieve campaign details.", e);
		return respond(500, {}, "Failed to retrieve campaign details.", false);
	}

	// A user-initiated start needs a fresh campaign. A capacity retry is checked separately,
	// by claiming it, because merely reading the status isn't enough there.
	if (!retryingCapacity && campaign.Items?.[0]?.status?.S != "AVAILABLE") {
		return respond(404, {}, "Campaign doesn't exist or is not in 'AVAILABLE' status.", false);
	}

	if (retryingCapacity) {

		// Only one retry may hold a campaign at a time. The monitor fires every minute and
		// this function is allowed to run for a full minute, so two invocations can overlap -
		// and if both got as far as reserving capacity, the campaign would be paying for two
		// sets of instances it can only ever use one of.
		//
		// The claim doubles as the status check: it only succeeds from AWAITING_CAPACITY, so a
		// campaign the user cancelled while it waited is refused here. It's a lease rather
		// than a flag so that an invocation which dies mid-flight releases the campaign
		// instead of stranding it.
		const claimedAt = new Date().getTime();

		try {
			await ddb.updateItem({
				Key: {
					userid: {S: entity},
					keyid: {S: `campaigns:${campaignId}`}
				},
				TableName: "Campaigns",
				UpdateExpression: "SET #status = :acquiring, capacityClaimedAt = :now",
				ConditionExpression: "#status = :awaiting OR (#status = :acquiring AND capacityClaimedAt < :stale)",
				ExpressionAttributeNames: {
					"#status": "status"
				},
				ExpressionAttributeValues: {
					":acquiring": {S: "ACQUIRING_CAPACITY"},
					":awaiting": {S: "AWAITING_CAPACITY"},
					":now": {N: claimedAt.toString()},
					":stale": {N: (claimedAt - CAPACITY_CLAIM_LEASE_MS).toString()}
				}
			}).promise();
		} catch (e) {
			if (e.code == "ConditionalCheckFailedException") {
				console.log(`[-] Campaign ${campaignId} is already being retried, or is no longer waiting.`);
				return respond(200, {}, "Campaign is already being retried, or is no longer waiting.", false);
			}

			console.log("Failed to claim campaign for a capacity retry.", e);
			return respond(500, {}, "Failed to claim campaign for a capacity retry.", false);
		}
	}

	// Giving up has to happen somewhere that runs on every retry, and this is it. The monitor
	// only pokes this function; it doesn't decide when a campaign has waited long enough.
	if (retryingCapacity) {
		const waitUntil = parseInt(campaign.Items[0].capacityWaitUntil?.N ?? "0");

		if (!!waitUntil && new Date().getTime() > waitUntil) {
			console.log(`[!] Campaign ${campaignId} waited past ${new Date(waitUntil).toISOString()} without capacity; giving up.`);

			await markCampaign(entity, campaignId, {
				active: false,
				status: "INSUFFICIENT_CAPACITY",
				spotFleetRequestId: `expired:${campaignId}`
			});

			return respond(200, {}, "Campaign gave up waiting for capacity.", false);
		}
	}

	// Test whether the provided presigned URL is expired. A parked campaign is expected to
	// outlive the URL the user submitted with it - they're signed in the browser for an hour -
	// so this only guards the immediate path, where that URL is the one the nodes will use.
	// The retry path re-signs from the object itself just before launching.
	let expires, duration;

	if (!retryingCapacity) {
		try {
			expires = /[^-]Expires=([\d]+)&/.exec(manifest.hashFileUrl)?.[1];

			if (!!!expires) {
				let date = /X-Amz-Date=([^&]+)&/.exec(manifest.hashFileUrl)?.[1];
				let seconds = /X-Amz-Expires=([\d]+)&/.exec(manifest.hashFileUrl)?.[1];

				date = new Date(Date.parse(date.replace(/(....)(..)(..T..)(..)/, "$1-$2-$3:$4:"))).getTime();

				expires = date + (seconds * 1000)
			}

			duration = expires - (new Date().getTime() / 1000);

			if (duration < 900) {
				return respond(400, {}, `hashFileUrl must be valid for at least 900 seconds, got ${Math.floor(duration)}`, false);
			}
		} catch (e) {
			console.log(e);
			return respond(400, {}, "Invalid hashFileUrl; missing expiration", false);
		}
	}

	// Campaign is valid. Get AZ pricing and Image AMI
	// * Again in parallel, to save, like, some more milliseconds.

	const ec2 = new aws.EC2({region: manifest.region});
	let pricing, image;

	const imageFilters = [{
        Name: "virtualization-type",
        Values: ["hvm"]
    },{
    	Name: "root-device-type",
    	Values: ["ebs"]
    }];

	imageFilters.push({
    	Name: "architecture",
    	Values: [archs[manifest.instanceType]]
    });

    const defaultImageName = "Deep Learning Base OSS Nvidia Driver GPU AMI (Amazon Linux 2023) *";

	imageFilters.push({
    	Name: "name",
    	Values: [amis[manifest.instanceType] || defaultImageName]
    });

    const defaultImageOwner = "898082745236";

	imageFilters.push({
    	Name: "owner-id",
    	Values: [owners[manifest.instanceType] || defaultImageOwner]
    });

    console.log(imageFilters);

	// Campaigns created before On-Demand support have no provisioningModel; they're spot.
	const provisioningModel = manifest.provisioningModel ?? "spot";

	console.log(`[*] Executing campaign ${campaignId} with the '${provisioningModel}' provisioning model.`);

	try {
		[pricing, image] = await Promise.all([
			(provisioningModel == "on-demand") ?
				getOnDemandPrice(manifest.instanceType, manifest.region) :
				ec2.describeSpotPriceHistory({
					EndTime: Math.round(Date.now() / 1000),
					ProductDescriptions: [ "Linux/UNIX (Amazon VPC)" ],
					InstanceTypes: [ manifest.instanceType ],
					StartTime: Math.round(Date.now() / 1000)
				}).promise(),

			ec2.describeImages({
				Filters: imageFilters
			}).promise()
		]);
	} catch (e) {
		console.log("Failed to retrieve price and image details.", e);
		return respond(500, {}, "Failed to retrieve price and image details.", false);
	}

	// Normalise both models down to a single per-instance hourly rate. For spot this is the
	// average across the region's AZs; for On-Demand it's the published rate.
	const hourlyRate = (provisioningModel == "on-demand") ?
		pricing :
		pricing.SpotPriceHistory.reduce((average, entry) => average + (entry.SpotPrice / pricing.SpotPriceHistory.length), 0);

	if (!hourlyRate || !isFinite(hourlyRate)) {
		console.log(`Unable to determine an hourly rate for ${manifest.instanceType} in ${manifest.region}.`);
		return respond(500, {}, "Unable to determine an hourly rate for the requested instance.", false);
	}

	console.log(image);

	image = image.Images.reduce((newest, entry) => 
		entry.CreationDate > newest.CreationDate ? entry : newest
	, { CreationDate: '1980-01-01T00:00:00.000Z' });

	if (!!!image.ImageId) {
		console.log("Unable to find a suitable AMI.");
		return respond(500, {}, "Unable to find a suitable AMI.", false);
	}

	// Calculate the necessary volume size

	const volumeSize = (Math.ceil(manifest.wordlistSize / 1073741824) * 2) + 1;
	console.log(`Wordlist is ${manifest.wordlistSize / 1073741824}GiB. Allocating ${volumeSize}GiB`);

	const instance_userdata = new Buffer.from(fs.readFileSync(__dirname + '/userdata.sh', 'utf-8')
		.replace("{{APIGATEWAY}}", process.env.apigateway)
		.replace("{{MANIFESTPATH}}", `${entity}/campaigns/${campaignId}`)
		// Nodes divide the keyspace by their position in the fleet, which is only safe once
		// the fleet is complete. Baking in the count they're waiting for is what lets a node
		// tell a fleet that is still filling from one that is never going to fill.
		.replace("{{INSTANCECOUNT}}", parseInt(manifest.instanceCount)))
		.toString('base64');

	// The lower of the user's target and the deployment-wide ceiling. This is the number the
	// monitor enforces against, and the number that bounds how long the fleet may live.
	const maxCost = Math.min(parseFloat(manifest.priceTarget), parseFloat(variables.campaign_max_price));

	let spotFleetParams;

	// On-Demand campaigns don't use a spot fleet request, so skip building one entirely.
	if (provisioningModel != "on-demand") {
	try {

		// Build a launchSpecification for each AZ in the target region.

		const launchSpecificationTemplate = {
            ImageId: image.ImageId,
			KeyName: "npk-key",
			InstanceType: manifest.instanceType,
            NetworkInterfaces: [
                {
                    DeviceIndex: 0,
                    DeleteOnTermination: true,
                    AssociatePublicIpAddress: true
                }
            ],
            BlockDeviceMappings: [{
				DeviceName: '/dev/xvdb',
				Ebs: {
					DeleteOnTermination: true,
					Encrypted: false,
					VolumeSize: volumeSize,
					VolumeType: "gp2"
				}
			}],
            IamInstanceProfile: {
				Arn: variables.instanceProfile
			},
            TagSpecifications: [{
				ResourceType: "instance",
				Tags: [{
					Key: "MaxCost",
					Value: maxCost.toString()
				}]
			}],
            UserData: instance_userdata
        }

		/*const launchSpecificationTemplate = {
			IamInstanceProfile: {
				Arn: variables.instanceProfile
			},
			ImageId: image.ImageId,
			KeyName: "npk-key",
			InstanceType: manifest.instanceType,
			BlockDeviceMappings: [{
				DeviceName: '/dev/xvdb',
				Ebs: {
					DeleteOnTermination: true,
					Encrypted: false,
					VolumeSize: volumeSize,
					VolumeType: "gp2"
				}
			}],
			NetworkInterfaces: [{
				AssociatePublicIpAddress: true,
				DeviceIndex: 0,
				// SubnetId: Gets populated below.
			}],
			Placement: {
				// AvailabilityZone: Gets populated below.
			},
			TagSpecifications: [{
				ResourceType: "instance",
				Tags: [{
					Key: "MaxCost",
					Value: ((manifest.priceTarget < variables.campaign_max_price) ? manifest.priceTarget : variables.campaign_max_price).toString()
				}, {
					Key: "ManifestPath",
					Value: `${entity}/campaigns/${campaignId}`
				}]
			}],
			UserData: instance_userdata
		};*/

		// Create a copy of the launchSpecificationTemplate for each AvailabilityZone in the campaign's region.
		console.log(variables.availabilityZones)

		const launchSpecifications = Object.keys(variables.availabilityZones[manifest.region]).reduce((specs, entry) => {
			const az = JSON.parse(JSON.stringify(launchSpecificationTemplate)); // Have to deep-copy to avoid referential overrides.

			// az.Placement.AvailabilityZone = entry;
			az.NetworkInterfaces[0].SubnetId = variables.availabilityZones[manifest.region][entry];

			return specs.concat(az);
		}, []);

		const maxDuration = (Number(manifest.instanceDuration) < variables.campaign_max_price / hourlyRate) ? Number(manifest.instanceDuration) : variables.campaign_max_price / hourlyRate;

		console.log(`Setting Duration to ${maxDuration} (Spot average $${hourlyRate} with limit of $${variables.campaign_max_price})`);

		spotFleetParams = {
			SpotFleetRequestConfig: {
				AllocationStrategy: "lowestPrice",
				IamFleetRole: variables.iamFleetRole,
				InstanceInterruptionBehavior: "terminate",
				LaunchSpecifications: launchSpecifications,
				SpotPrice: (manifest.priceTarget / (manifest.instanceCount * manifest.instanceDuration) * 2).toString(),
				TargetCapacity: manifest.instanceCount,
				ReplaceUnhealthyInstances: false,
				TerminateInstancesWithExpiration: true,
				Type: "request",
				ValidFrom: (new Date().getTime() / 1000),
				ValidUntil: (new Date().getTime() / 1000) + (maxDuration * 3600)
			}
		};

		console.log(JSON.stringify(spotFleetParams));
	} catch (e) {
		console.log("Failed to generate launch specifications.", e);
		return respond(500, {}, "Failed to generate launch specifications.", false);
	}
	}

	// 'requestId' is the fleet handle NPK tracks the campaign by, regardless of model.
	// For On-Demand campaigns it's an EC2 Fleet ID; for spot it's a Spot Fleet Request ID.
	let requestId, launchTemplateId, capacityReservationId;

	if (provisioningModel == "on-demand") {

		// Bound the fleet's lifetime by whichever runs out first: the requested duration, or
		// the point at which the whole fleet would burn through the campaign's cost ceiling.
		const instanceCount = parseInt(manifest.instanceCount);
		const costLimitedDuration = maxCost / (hourlyRate * instanceCount);
		const maxDuration = Math.min(Number(manifest.instanceDuration), costLimitedDuration);

		console.log(`Setting Duration to ${maxDuration} (On-Demand $${hourlyRate}/hr x ${instanceCount} with limit of $${maxCost})`);

		// These two checks used to run after the launch template was created, and each needed
		// its own cleanup path. Neither depends on AWS state, so they now run before anything
		// exists that could leak.
		//
		// A fleet whose budget buys less than a minute of runtime can't accomplish anything,
		// and EC2 rejects a ValidUntil that's already passed. Fail with something readable.
		if (maxDuration < (1 / 60)) {
			console.log(`Campaign budget of $${maxCost} buys ${maxDuration} hours at $${hourlyRate}/hr x ${instanceCount}.`);
			return respond(400, {}, `Campaign price limit of $${maxCost} is too low to run ${instanceCount} x ${manifest.instanceType} On-Demand at $${hourlyRate}/hr.`, false);
		}

		const subnets = variables.availabilityZones?.[manifest.region] ?? {};

		// A manifest can name a region that's since been dropped from the deployment.
		if (!Object.keys(subnets).length) {
			console.log(`No subnets are known for region ${manifest.region}.`);
			return respond(400, {}, `No usable subnets in ${manifest.region}. The region may no longer be part of this deployment.`, false);
		}

		// Reserve the capacity before committing to anything else. A reservation is per-AZ and
		// all-or-nothing: AWS either holds the full instance count in that zone or refuses it,
		// so trying each zone in turn is a probe that costs nothing when it fails. Holding the
		// capacity up front is what makes the fleet fill completely and at once. Without it the
		// fleet trickles in over tens of minutes, and nodes that boot at different times divide
		// the keyspace against different fleet sizes - which is silent, and wastes the whole run.
		let reservation;

		try {
			reservation = await acquireCapacityReservation(ec2, {
				campaignId,
				instanceType: manifest.instanceType,
				instanceCount,
				zones: Object.keys(subnets),
				hours: maxDuration
			});
		} catch (e) {
			// A quota refusal lands here and will land here again on every retry until the
			// campaign's deadline passes. That's deliberate: it costs nothing, and guessing
			// which failures are permanent would mean cancelling campaigns that might have
			// launched. Hand it back so the next pass can try rather than waiting out the lease.
			if (retryingCapacity) {
				await releaseCapacityClaim(entity, campaignId);
			}

			console.log("Failed to reserve capacity.", e);
			return respond(500, {}, `Failed to reserve capacity: ${e.message ?? e}`, false);
		}

		// Nothing available in the region right now. Park the campaign rather than launching a
		// partial fleet; the monitor brings us back here every minute until capacity appears or
		// the campaign's wait deadline passes.
		if (!reservation) {
			return await parkCampaignForCapacity(entity, campaignId, campaign.Items[0], {
				instanceCount,
				instanceType: manifest.instanceType,
				region: manifest.region,
				provisioningModel
			});
		}

		// A campaign that waited has outlived the presigned URL the user submitted with it, so
		// the manifest the nodes read is rewritten with a fresh one before any of them boot.
		if (retryingCapacity) {
			try {
				await refreshHashFileUrl(entity, campaignId, manifest);
			} catch (e) {
				await Promise.all([
					cancelCapacityReservationQuietly(ec2, reservation.reservationId),
					releaseCapacityClaim(entity, campaignId)
				]);

				console.log("Failed to refresh the hash file URL.", e);
				return respond(500, {}, "Failed to refresh the hash file URL.", false);
			}
		}

		// EC2 Fleet launches exclusively from launch templates, so each campaign gets its own.
		// It's torn down alongside the fleet by the monitor or by delete_campaign.
		const launchTemplateName = `npk-${campaignId}`;

		try {
			const launchTemplate = await ec2.createLaunchTemplate({
				LaunchTemplateName: launchTemplateName,
				LaunchTemplateData: {
					ImageId: image.ImageId,
					KeyName: "npk-key",
					InstanceType: manifest.instanceType,

					// Launch into the reservation rather than alongside it. Targeting it
					// explicitly is what makes these instances consume the capacity we're
					// already paying to hold, instead of racing the open market for more.
					CapacityReservationSpecification: {
						CapacityReservationTarget: {
							CapacityReservationId: reservation.reservationId
						}
					},
					BlockDeviceMappings: [{
						DeviceName: '/dev/xvdb',
						Ebs: {
							DeleteOnTermination: true,
							Encrypted: false,
							VolumeSize: volumeSize,
							VolumeType: "gp2"
						}
					}],
					IamInstanceProfile: {
						Arn: variables.instanceProfile
					},

					// Fleets only propagate instance tags declared in the launch template.
					// 'HourlyRate' lets the monitor cost the campaign without calling Pricing.
					TagSpecifications: [{
						ResourceType: "instance",
						Tags: [{
							Key: "MaxCost",
							Value: maxCost.toString()
						}, {
							Key: "HourlyRate",
							Value: hourlyRate.toString()
						}, {
							Key: "CampaignId",
							Value: campaignId
						}]
					}],
					UserData: instance_userdata
				},
				TagSpecifications: [{
					ResourceType: "launch-template",
					Tags: [{
						Key: "CampaignId",
						Value: campaignId
					}]
				}]
			}).promise();

			launchTemplateId = launchTemplate.LaunchTemplate.LaunchTemplateId;

			console.log(`[+] Created launch template ${launchTemplateId} for campaign ${campaignId}`);
		} catch (e) {
			await Promise.all([
				cancelCapacityReservationQuietly(ec2, reservation.reservationId),
				retryingCapacity ? releaseCapacityClaim(entity, campaignId) : Promise.resolve()
			]);

			console.log("Failed to create launch template.", e);
			return respond(500, {}, "Failed to create launch template.", false);
		}

		const fleetParams = {
			LaunchTemplateConfigs: [{
				LaunchTemplateSpecification: {
					LaunchTemplateId: launchTemplateId,
					Version: "$Latest"
				},

				// A reservation lives in exactly one AZ, so there is nowhere else for these
				// instances to go. Offering the fleet other subnets would only let it launch
				// outside the capacity we're paying to hold.
				Overrides: [{
					SubnetId: subnets[reservation.availabilityZone]
				}]
			}],
			TargetCapacitySpecification: {
				TotalTargetCapacity: instanceCount,
				OnDemandTargetCapacity: instanceCount,
				DefaultTargetCapacityType: "on-demand"
			},
			OnDemandOptions: {
				AllocationStrategy: "lowest-price"
			},
			Type: "request",

			// This pair is the runaway protection that survives a management-plane failure:
			// EC2 itself terminates the instances when the fleet expires.
			TerminateInstancesWithExpiration: true,
			ValidFrom: new Date(),
			ValidUntil: new Date(new Date().getTime() + (maxDuration * 3600 * 1000)),

			TagSpecifications: [{
				ResourceType: "fleet",
				Tags: [{
					Key: "Name",
					Value: launchTemplateName
				}, {
					Key: "CampaignId",
					Value: campaignId
				}, {
					Key: "MaxCost",
					Value: maxCost.toString()
				}, {
					Key: "HourlyRate",
					Value: hourlyRate.toString()
				}]
			}]
		};

		console.log(JSON.stringify(fleetParams));

		let fleet;

		try {
			fleet = await ec2.createFleet(fleetParams).promise();
		} catch (e) {
			console.log("Failed to create EC2 fleet.", e);

			// Don't strand the template, and above all don't strand the reservation - it bills
			// at the full On-Demand rate whether or not anything is running in it.
			await Promise.all([
				deleteLaunchTemplateQuietly(ec2, launchTemplateId),
				cancelCapacityReservationQuietly(ec2, reservation.reservationId),
				retryingCapacity ? releaseCapacityClaim(entity, campaignId) : Promise.resolve()
			]);

			return respond(500, {}, "Failed to create EC2 fleet.", false);
		}

		requestId = fleet.FleetId;
		capacityReservationId = reservation.reservationId;

		console.log(`Successfully requested EC2 fleet ${requestId} against reservation ${capacityReservationId}`);

	} else {

		let spotFleetRequest;

		try {
			spotFleetRequest = await ec2.requestSpotFleet(spotFleetParams).promise();
		} catch (e) {
			console.log("Failed to request spot fleet.", e);
			return respond(500, {}, "Failed to request spot fleet.", false);
		}

		requestId = spotFleetRequest.SpotFleetRequestId;

		console.log(`Successfully requested spot fleet ${requestId}`);
	}

	// Campaign created successfully.

	try {
		const updateParams = aws.DynamoDB.Converter.marshall({
			active: true,
			status: "STARTING",

			// Keyed by the 'SpotFleetRequests' GSI for both models; holds an EC2 Fleet ID
			// when the campaign is On-Demand.
			spotFleetRequestId: requestId,
			provisioningModel,
			launchTemplateId: launchTemplateId ?? "<none>",

			// Recorded so delete_campaign can release it directly. The reservation also
			// carries a CampaignId tag, which is how the monitor finds it when this write
			// is the thing that failed.
			capacityReservationId: capacityReservationId ?? "<none>",
			hourlyRate: hourlyRate.toString(),
			startTime: Math.floor(new Date().getTime() / 1000),
			eventType: "CampaignStarted",
			lastuntil: 0,

			// Cleared so a campaign that waited doesn't keep a stale deadline if it is ever
			// restarted, and so the monitor's pending query stops returning it.
			capacityWaitUntil: 0
		});

		const updateCampaign = await ddb.updateItem({
			Key: {
				userid: {S: entity},
				keyid: {S: `campaigns:${campaignId}`}
			},
			TableName: "Campaigns",
			AttributeUpdates: Object.keys(updateParams).reduce((attrs, entry) => {
				attrs[entry] = {
					Action: "PUT",
					Value: updateParams[entry]
				};

				return attrs;
			}, {})
			
		}).promise();
	} catch (e) {
		console.log("Fleet submitted, but failed to mark Campaign as 'STARTING'. This is a catastrophic error.", e);
		return respond(500, {}, "Fleet submitted, but failed to mark Campaign as 'STARTING'. This is a catastrophic error.", false);
	}

	return respond(200, {}, { msg: "Campaign started successfully", campaignId: campaignId, spotFleetRequestId: requestId }, true);
}

// Used on every abort path after the template exists. Cleanup failing must never mask the
// error that caused the abort, so this only ever logs.
function deleteLaunchTemplateQuietly(ec2, launchTemplateId) {
	return ec2.deleteLaunchTemplate({ LaunchTemplateId: launchTemplateId }).promise()
		.catch((e) => console.log(`[-] Also failed to clean up launch template ${launchTemplateId}.`, e));
}

// Same contract, but this one matters more: a capacity reservation bills at the full
// On-Demand rate from the moment it exists, occupied or not. An orphaned reservation is a
// silent, open-ended charge, so every abort path after one is created has to release it.
function cancelCapacityReservationQuietly(ec2, capacityReservationId) {
	return ec2.cancelCapacityReservation({ CapacityReservationId: capacityReservationId }).promise()
		.catch((e) => console.log(`[-] Also failed to release capacity reservation ${capacityReservationId}.`, e));
}

// Capacity reservations are per-AZ and all-or-nothing: AWS either has the full instance count
// in that zone and holds it for us, or the call fails and nothing is charged. Walking the
// zones is therefore a free probe for "is there room for this campaign right now", and the
// answer, when it's yes, comes with the capacity already secured.
async function acquireCapacityReservation(ec2, params) {

	const { campaignId, instanceType, instanceCount, zones, hours } = params;

	// A retry that died between reserving capacity and recording it would otherwise reserve
	// again on its next attempt, stacking up reservations that all bill in parallel and that
	// nothing knows to release. Adopting whatever is already held for this campaign makes the
	// whole operation idempotent, which is what allows it to be retried at all.
	try {
		const existing = await ec2.describeCapacityReservations({
			Filters: [{
				Name: "tag:CampaignId",
				Values: [campaignId]
			}, {
				Name: "state",
				Values: ["active"]
			}]
		}).promise();

		const usable = (existing.CapacityReservations ?? []).find((reservation) =>
			reservation.InstanceType == instanceType &&
			reservation.TotalInstanceCount >= instanceCount
		);

		if (!!usable) {
			console.log(`[+] Reusing existing capacity reservation ${usable.CapacityReservationId} in ${usable.AvailabilityZone}.`);

			return {
				reservationId: usable.CapacityReservationId,
				availabilityZone: usable.AvailabilityZone
			};
		}
	} catch (e) {
		// Not being able to check is not a reason to refuse to launch; the worst case is the
		// leak this check exists to avoid, which EndDate already bounds.
		console.log(`[-] Unable to check for an existing capacity reservation for ${campaignId}.`, e);
	}

	// AWS requires an end date at least an hour out. Beyond the campaign's own runtime this
	// only bounds how long an orphaned reservation could bill for, so it's kept close: the
	// fleet's own ValidUntil is what actually ends the campaign.
	const endDate = new Date(new Date().getTime() + (Math.max(hours, 1) * 3600 * 1000) + (15 * 60 * 1000));

	for (const az of zones) {
		try {
			const result = await ec2.createCapacityReservation({
				InstanceType: instanceType,
				InstancePlatform: "Linux/UNIX",
				AvailabilityZone: az,
				InstanceCount: instanceCount,
				Tenancy: "default",

				// Without this, any matching instance in the account drifts into the
				// reservation and eats capacity this campaign is paying to hold.
				InstanceMatchCriteria: "targeted",
				EndDate: endDate,
				EndDateType: "limited",

				TagSpecifications: [{
					ResourceType: "capacity-reservation",
					Tags: [{
						Key: "CampaignId",
						Value: campaignId
					}, {
						Key: "Name",
						Value: `npk-${campaignId}`
					}]
				}]
			}).promise();

			const reservationId = result.CapacityReservation?.CapacityReservationId;

			if (!reservationId) {
				console.log(`[-] createCapacityReservation in ${az} returned no reservation ID.`, JSON.stringify(result));
				continue;
			}

			console.log(`[+] Reserved ${instanceCount} x ${instanceType} in ${az} as ${reservationId}.`);

			return { reservationId, availabilityZone: az };

		} catch (e) {
			// No room in this zone is the expected answer while waiting, not a failure.
			if (e.code == "InsufficientInstanceCapacity" || e.code == "InsufficientCapacity") {
				console.log(`[-] No capacity for ${instanceCount} x ${instanceType} in ${az}.`);
				continue;
			}

			// Anything else - a quota refusal above all - would repeat in every zone and
			// forever after, so it surfaces to the user instead of looking like patience.
			throw e;
		}
	}

	return null;
}

// Park a campaign that has nowhere to launch. The deadline is set once, on the first park, so
// that retrying doesn't quietly extend how long a campaign can sit costing nothing but also
// achieving nothing.
async function parkCampaignForCapacity(entity, campaignId, campaignRow, details) {

	const existingDeadline = parseInt(campaignRow?.capacityWaitUntil?.N ?? "0");
	const waitUntil = !!existingDeadline ? existingDeadline : new Date().getTime() + CAPACITY_WAIT_MAX_MS;

	// All parked campaigns share one GSI key so the monitor can find them with a single
	// query instead of scanning the table. It's replaced by the real fleet ID at launch.
	//
	// Conditional, because a user can cancel a campaign during the minute a retry is in
	// flight. Writing unconditionally would put a cancelled campaign back in the queue, where
	// it would keep retrying and could eventually launch the instances they just cancelled.
	try {
		await markCampaign(entity, campaignId, {
			active: true,
			status: "AWAITING_CAPACITY",
			spotFleetRequestId: AWAITING_CAPACITY_KEY,
			provisioningModel: details.provisioningModel,
			capacityWaitUntil: waitUntil
		}, {
			ConditionExpression: "attribute_not_exists(#status) OR #status IN (:available, :awaiting, :acquiring)",
			ExpressionAttributeNames: {
				"#status": "status"
			},
			ExpressionAttributeValues: {
				":available": {S: "AVAILABLE"},
				":awaiting": {S: "AWAITING_CAPACITY"},
				":acquiring": {S: "ACQUIRING_CAPACITY"}
			}
		});
	} catch (e) {
		if (e.code == "ConditionalCheckFailedException") {
			console.log(`[-] Campaign ${campaignId} is no longer waiting; not re-queuing it.`);
			return respond(200, {}, "Campaign is no longer waiting for capacity.", false);
		}

		throw e;
	}

	const minutesLeft = Math.round((waitUntil - new Date().getTime()) / 60000);

	console.log(`[*] No capacity for ${details.instanceCount} x ${details.instanceType} in ${details.region}; campaign ${campaignId} is waiting (${minutesLeft} minutes left).`);

	return respond(202, {}, {
		msg: `No capacity for ${details.instanceCount} x ${details.instanceType} in ${details.region} right now. The campaign will start automatically when capacity becomes available.`,
		campaignId,
		status: "AWAITING_CAPACITY",
		waitUntil
	}, true);
}

// A campaign that waited has outlived the presigned URL the user submitted with it - the
// browser signs those for an hour. The object is in NPK's own bucket under a known key, so
// the URL is re-signed here and the manifest the nodes read is rewritten before any of them
// boot. Without this, every campaign that waited would launch nodes that can't fetch hashes.
async function refreshHashFileUrl(entity, campaignId, manifest) {

	if (!manifest.hashFile) {
		throw new Error("Manifest has no hashFile key, so its download URL can't be re-signed.");
	}

	manifest.hashFileUrl = await s3.getSignedUrlPromise('getObject', {
		Bucket: variables.userdata_bucket,
		Key: `${entity}/${manifest.hashFile}`,
		Expires: 3600
	});

	await s3.putObject({
		Bucket: variables.userdata_bucket,
		Key: `${entity}/campaigns/${campaignId}/manifest.json`,
		Body: JSON.stringify(manifest)
	}).promise();

	console.log(`[+] Re-signed the hash file URL for campaign ${campaignId}.`);
}

// Hand a campaign back to the queue after a retry fails, so the next pass can pick it up
// immediately instead of waiting out the claim lease. Failing to release is survivable -
// that is exactly what the lease is for - so this only ever logs.
function releaseCapacityClaim(entity, campaignId) {
	return markCampaign(entity, campaignId, { status: "AWAITING_CAPACITY" })
		.catch((e) => console.log(`[-] Failed to release the capacity claim on ${campaignId}.`, e));
}

// 'condition' is optional, and when present carries the ConditionExpression plus its
// attribute names and values. AttributeUpdates and ConditionExpression can be combined; it's
// UpdateExpression that can't be mixed with AttributeUpdates.
function markCampaign(entity, campaignId, values, condition) {

	const marshalled = aws.DynamoDB.Converter.marshall(values);

	return ddb.updateItem({
		Key: {
			userid: {S: entity},
			keyid: {S: `campaigns:${campaignId}`}
		},
		TableName: "Campaigns",
		AttributeUpdates: Object.keys(marshalled).reduce((attrs, entry) => {
			attrs[entry] = {
				Action: "PUT",
				Value: marshalled[entry]
			};

			return attrs;
		}, {}),

		...(condition ?? {})
	}).promise();
}

// Resolve the published On-Demand rate for an instance type from the Pricing API. The API is
// only served from a handful of regions, so it's always queried against us-east-1.
async function getOnDemandPrice(instanceType, region) {

	const pricingApi = new aws.Pricing({ region: "us-east-1", apiVersion: "2017-10-15" });

	const products = await pricingApi.getProducts({
		ServiceCode: "AmazonEC2",
		Filters: [
			{ Type: "TERM_MATCH", Field: "instanceType", Value: instanceType },
			{ Type: "TERM_MATCH", Field: "regionCode", Value: region },
			{ Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
			{ Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
			{ Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
			{ Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" }
		],
		MaxResults: 10
	}).promise();

	if (!products.PriceList?.length) {
		throw new Error(`No On-Demand price found for ${instanceType} in ${region}`);
	}

	// PriceList entries are JSON-encoded strings of the shape:
	//   terms.OnDemand.<offerCode>.priceDimensions.<rateCode>.pricePerUnit.USD
	const price = products.PriceList
		.map(entry => (typeof entry == "string") ? JSON.parse(entry) : entry)
		.reduce((cheapest, product) => {
			Object.values(product?.terms?.OnDemand ?? {}).forEach((offer) => {
				Object.values(offer?.priceDimensions ?? {}).forEach((dimension) => {
					const usd = parseFloat(dimension?.pricePerUnit?.USD);

					// Free-tier and $0 dimensions aren't the rate we're looking for.
					if (!!usd && (cheapest === null || usd < cheapest)) {
						cheapest = usd;
					}
				});
			});

			return cheapest;
		}, null);

	if (price === null) {
		throw new Error(`Unable to parse an On-Demand rate for ${instanceType} in ${region}`);
	}

	console.log(`[+] On-Demand rate for ${instanceType} in ${region} is $${price}/hr`);

	return price;
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
