"use strict";

const fs = require('fs');
const aws 	= require('aws-sdk');
const settings = JSON.parse(JSON.stringify(process.env));
settings.regions = JSON.parse(settings.regions);

const accountDetails = JSON.parse(fs.readFileSync('./accountDetails.json', 'ascii'));

aws.config.apiVersions = {
	dynamodb: 	'2012-08-10'
};

aws.config.update({region: settings.region});

const db = new aws.DynamoDB();

// How long an On-Demand fleet may hold zero instances before it's considered to have
// failed to obtain capacity. Generous: On-Demand capacity resolves in seconds, so this
// only has to clear the gap between createFleet returning and instances appearing.
const NEVER_LAUNCHED_GRACE_MS = 15 * 60 * 1000;

exports.main = async function(event, context, callback) {

	// Spot and On-Demand campaigns are tracked through entirely different EC2 APIs, so each
	// gets its own pass. They're independent: a failure in one must not mask the other, or
	// leave the other's cost ceiling unenforced.
	const passes = ["spot", "on-demand"];
	const results = await Promise.allSettled([
		processSpotFleets(),
		processOnDemandFleets()
	]);

	const messages = results.map((result, i) => {
		if (result.status == "rejected") {
			console.log(`[!] ${passes[i]} pass failed:`, result.reason);
			return `[!] ${passes[i]} pass failed: ${result.reason}`;
		}

		return result.value;
	});

	const summary = messages.join(' ');

	// Surface failures to the caller so the DLQ/SNS alarm path still fires.
	if (results.some(result => result.status == "rejected")) {
		return callback(summary);
	}

	return callback(null, summary);
};

async function processSpotFleets() {

	let spotFleets = {};
	let promises = [];

	// Enumerate spot fleet requests and histories across all regions.
	try {

		for (const region of Object.keys(settings.regions)) {
			const ec2 = new aws.EC2({region: region});

			promises.push(ec2.describeSpotFleetRequests({}).promise().then(async (data) => {

				for (let config of data.SpotFleetRequestConfigs) {
					// Skip fleets more than a day old, since some history items can expire before the fleet does.
					if (new Date(config.CreateTime).getTime() < new Date().getTime() - (1000 * 60 * 60 * 24)) {
						console.log(`[-] ${config.SpotFleetRequestId} created more than a day ago. Skipping.`);
						continue;
					}

					const history = await getSpotRequestHistory(ec2, config.SpotFleetRequestId);

					spotFleets[config.SpotFleetRequestId] = {
						...config,
						region,
						history,
						instances: {},
						price: 0
					};
				};
			}));
		};

		await Promise.all(promises);

		if (!Object.keys(spotFleets).length) {
			return "[*] No spot fleets to process.";
		} else {
			console.log(`[+] Found ${Object.keys(spotFleets).length} SFRs to process.`);
		}

	} catch (e) {
		console.log(e);
		throw new Error(`[!] Failed to retreive spot fleets and history: ${e}`);
	}

	promises = [];

	// Enumerate spot instances from all regions, and associate them with their SFRs.
	try {
		Object.keys(settings.regions).forEach(function(region) {
			const ec2 = new aws.EC2({region: region});

			promises.push(ec2.describeSpotInstanceRequests({}).promise().then((data) => {
				data.SpotInstanceRequests.forEach(function(request) {
					request.Tags = request.Tags.reduce((tags, tag) => {
						tags[tag.Key] = tag.Value;

						return tags;
					}, {});

					if (!request.Tags['aws:ec2spot:fleet-request-id']) {
						console.log(`[-] Instance ${request.InstanceId} has no SFR ID.`);
						console.log(request.Tags);
						return false
					}

					const sfr = request.Tags['aws:ec2spot:fleet-request-id'];

					spotFleets[sfr].instances[request.InstanceId] = {
						Status: {
							Code: request.Status.Code,
							Message: request.Status.Message
						},
						State: request.State
					}
				});

				return true;
			}));
		});

		await Promise.all(promises);

	} catch (e) {
		console.log(e);
		throw new Error(`[!] Failed to retreive spot instance statuses: ${e}`);
	}

	promises = [];

	try {
		Object.keys(spotFleets).forEach((fleetId) => {
			const fleet = spotFleets[fleetId];

			const instanceCount = Object.keys(fleet.instances).length;

			if (!instanceCount) {
				console.log(`[-] Found 0 instances for ${fleetId}`);
			} else {
				console.log(`[+] Found ${instanceCount} instances for ${fleetId}`);
			}

			const hasOpenInstances = Object.keys(fleet.instances).reduce((state, instanceId) => {
				const instance = fleet.instances[instanceId];

				if (['open', 'active'].indexOf(instance.State) > -1 ) {
					return true;
				}

				return state;
			}, false);

			if (!hasOpenInstances) {
				console.log(`[+] Fleet ${fleetId} with status ${fleet.SpotFleetRequestState} has open instances: ${hasOpenInstances}.`);
			}

			if (!!instanceCount && !hasOpenInstances && !/cancelled/.test(fleet.SpotFleetRequestState)) {
				const ec2 = new aws.EC2({region: fleet.region});

				promises.push(ec2.cancelSpotFleetRequests({
					TerminateInstances: true,
					SpotFleetRequestIds: [fleetId]
				}).promise().then((data) => {
					console.log(`[+] Cancelled ${fleetId} due to all instance requests being closed.`);
				}, (e) => {
					console.log(`[-] Unable to cancel ${fleetId} due to all instance requests being closed.`, e);
				}));
			}
		});
	} catch (e) {
		console.log(e);
		throw new Error(`[!] Failed to handle exhausted campaigns: ${e}`);
	}

	promises = [];
	const spotPrices = {};

	// Get spot instance events, along with price history for each instance type found.
	try {

		// Iterate over the identified SFRs and remove any that are cancelled and empty.
		spotFleets = Object.keys(spotFleets).reduce((fleets, fleetId) => {
			const fleet = spotFleets[fleetId];

			if (!!fleet.instances.length && /cancelled/.test(fleet.SpotFleetRequestState)) {
				console.log(`[-] Cancelled fleet [${fleet.SpotFleetRequestId}] has no instance statuses.`);
				return fleets;
			}

			if (/cancelled/.test(fleet.SpotFleetRequestState)) {
				const fleetState = (fleet.SpotFleetRequestState == "cancelled") ? "COMPLETED" : "STOPPING";

				promises.push(editCampaignViaRequestId(fleet.SpotFleetRequestId, {
					active: false,
					spotRequestHistory: fleet.history,
					spotRequestStatus: fleet.instances,
					status: fleetState
				}).then((data) => {
					console.log(`[+] Marked campaign of ${fleet.SpotFleetRequestId} as ${fleetState}`);
				}, (e) => {
					console.log(`[!] Failed attempting to update ${fleet.SpotFleetRequestId}`);
				}));

				if (fleet.SpotFleetRequestState == "cancelled") {
					return fleets;
				}
			}

			if (!!fleet.instances.length) {
				console.log(`[!] Fleet [${fleet.SpotFleetRequestId}] with status [${fleet.SpotFleetRequestState}] has no instance statuses.`);
			}

			// Loop over 'instanceChange' events to record the start and stop time of given instances.
			fleet.history.forEach((historyRecord) => {
				if (historyRecord.EventType != "instanceChange") {
					return false;
				}

				const event = JSON.parse(historyRecord.EventInformation.EventDescription);

				if (!historyRecord?.EventInformation?.InstanceId) {
					return false;
				}

				const instanceId = historyRecord.EventInformation.InstanceId;

				if (!fleet.instances[instanceId]) {
					// This can happen when nodes are new. Be lenient.
					return false;
				}

				// Create the basic record, to be populated based on event status.
				if (!fleet.instances[instanceId].history) {

					fleet.instances[instanceId].instanceType = event.instanceType;
					fleet.instances[instanceId].image = event.image;
					fleet.instances[instanceId].availabilityZone = event.availabilityZone;
					fleet.instances[instanceId].ProductDescriptions = event.ProductDescriptions;

					fleet.instances[instanceId].history = {
						startTime: 0,
						endTime: new Date().getTime() / 1000
					}
				}

				// Set record details based on event type.
				switch (historyRecord.EventInformation.EventSubType) {
					case "launched":
						fleet.instances[instanceId].history.startTime = new Date(historyRecord.Timestamp).getTime();
					break;

					case "terminated":
						fleet.instances[instanceId].history.endTime = new Date(historyRecord.Timestamp).getTime();
					break;
				}

				// Retrieve spot price history based on region and instance type.
				const spotKey = fleet.region + ":" + event.instanceType;

				// Skip remaining processing if it's already been requested.
				if (!!spotPrices[spotKey]) {
					return false;
				}

				spotPrices[spotKey] = {};

				const ec2 = new aws.EC2({region: fleet.region});
				promises.push(ec2.describeSpotPriceHistory({
					InstanceTypes: [event.instanceType],
					ProductDescriptions: ["Linux/UNIX (Amazon VPC)"],

					// Default to retrieving the last two days' spot prices.
					StartTime: (new Date().getTime() / 1000) - (60 * 60 * 48)
				}).promise().then((data) => {

					data.SpotPriceHistory.forEach(function(spotHistoryItem) {
						const az = spotHistoryItem.AvailabilityZone;
						const dateKey = new Date(spotHistoryItem.Timestamp).getTime();

						if (!spotPrices[spotKey][az]) {
							spotPrices[spotKey][az] = {};
						}

						spotPrices[spotKey][az][dateKey] = spotHistoryItem.SpotPrice;
					});
				}));
			});

			fleets[fleetId] = fleet;
			return fleets;
		}, {});

		await Promise.all(promises);

	} catch (e) {
		console.log(e);
		throw new Error(`[!] Failed to get instance history and prices: ${e}`);
	}

	promises = [];

	// Promises are all done. Let's calculate the instance costs, and roll them up to the fleet.
	try {

		console.log(spotPrices);

		Object.keys(spotFleets).forEach((fleetId) => {
			const fleet = spotFleets[fleetId];

			let badInstance = false;
			Object.keys(fleet.instances).forEach((instanceId) => {
				const instance = fleet.instances[instanceId];

				const prices = spotPrices?.[fleet.region + ':' + instance.instanceType]?.[instance.availabilityZone];

				if (!!!prices) {
					badInstance = true;
					return false;
				}

				prices[new Date().getTime()] = prices[Object.keys(prices).slice(-1)];

				const timestamps = Object.keys(prices).sort(function(a, b) { return a - b; });

				let accCost = 0;
				let accSeconds = 0;

				if (instance.history.startTime == 0) {
					badInstance = true;
					return false;
				}

				let duration = instance.history.endTime - instance.history.startTime;

				// This isn't a thing anymore. Fun times.
				//duration = (duration < 3600) ? 3600 : duration;

				let tempStartTime = instance.history.startTime;

				// console.log("duration: " + duration);
				timestamps.forEach(function(e) {
					// console.log("Checking against time: " + e)
					if (e <= tempStartTime || accSeconds >= duration) {
						return true;
					}

					var ppms = prices[e] / 3600;
					var mseconds = e - tempStartTime;

					if (accSeconds + mseconds > duration) {
						mseconds -= (accSeconds + mseconds - duration);
					}

					accCost += (mseconds * ppms);
					accSeconds += mseconds;

					tempStartTime += mseconds;
				});

				console.log(`[*] Instance ${instanceId} up for ${accSeconds} seconds; estimated cost $${accCost.toFixed(4)}`);
				instance.price = accCost;
				fleet.price += accCost;
			});

			// Skip the fleet if an instance has partially truncated history.
			if (badInstance) {
				console.log(`[!] SFR ${fleetId} has incomplete instance history. Skipping update.`);
				return false;
			}

			const tags = {};
			fleet.SpotFleetRequestConfig.LaunchSpecifications[0].TagSpecifications.forEach((tagspec) => {
				tagspec.Tags.forEach(function(tag) {
					tags[tag.Key] = tag.Value;
				});
			});

			const ec2 = new aws.EC2({region: fleet.region});
			const fleetState = (/cancelled/.test(fleet.SpotFleetRequestState)) ? "STOPPING" : "RUNNING";

			promises.push(editCampaignViaRequestId(fleetId, {
				active: true,
				price: fleet.price,
				spotRequestHistory: fleet.history,
				spotRequestStatus: fleet.instances,
				status: fleetState
			}).then((data) => {
				console.log(`[+] Updated price of fleet ${fleetId}`);
			}, (e) => {
				console.log(`[!] Failed attempting to update price for ${fleetId}`);
			}));

			if (fleet.price > parseFloat(tags.MaxCost) || fleet.price > parseFloat(settings.campaign_max_price)) {
				console.log("Fleet " + fleetId + " costs exceed limits; terminating.");

				promises.push(ec2.cancelSpotFleetRequests({
					TerminateInstances: true,
					SpotFleetRequestIds: [fleetId]
				}).promise().then((data) => {
					console.log(`Successfully terminated ${fleetId}`);
					return Promise.resolve();
				}, (e) => {
					console.log(e);
					return criticalAlert(`Failed to terminate fleet ${fleetId} with cost $${fleet.price}`);
				}));
			}

			if (fleet.price > parseFloat(tags.MaxCost) * 1.1 || fleet.price > parseFloat(settings.campaign_max_price) * 1.1) {
				console.log("Fleet " + fleetId + " costs CRITICALLY exceed limits (" + fleet.price + "); terminating and raising critical alert.");
				promises.push(criticalAlert("SFR " + fleetId + " current price is: " + fleet.price + "; Terminating."));

				promises.push(ec2.cancelSpotFleetRequests({
					TerminateInstances: true,
					SpotFleetRequestIds: [fleetId]
				}).promise().then((data) => {
					console.log(`Successfully terminated ${fleetId}`);
					return Promise.resolve();
				}, (e) => {
					return criticalAlert(`Failed to terminate fleet ${fleetId} with cost $${fleet.price}`);
				}));
			}
		});

		await Promise.all(promises);

	} catch (e) {
		console.log(e);
		throw new Error(`[!] Failed to update spot instance costs: ${e}`);
	}

	return `[+] Reviewed [${Object.keys(spotFleets).length}] SFRs.`;
};

async function processOnDemandFleets() {

	let fleets = {};

	// Enumerate NPK-owned EC2 Fleets across all regions. describeFleets can't filter on tags,
	// so everything is pulled and the CampaignId tag is matched here.
	try {
		await Promise.all(Object.keys(settings.regions).map(async (region) => {
			const ec2 = new aws.EC2({ region });

			for (const fleet of await getAllFleets(ec2)) {
				const tags = tagsToMap(fleet.Tags);

				if (!tags.CampaignId) {
					continue;
				}

				// Skip fleets more than a day old, matching the spot pass. Deleted fleets
				// linger in the API for a while after their instances are gone.
				if (new Date(fleet.CreateTime).getTime() < new Date().getTime() - (1000 * 60 * 60 * 24)) {
					console.log(`[-] ${fleet.FleetId} created more than a day ago. Skipping.`);
					continue;
				}

				fleets[fleet.FleetId] = {
					...fleet,
					region,
					tags,
					history: await getFleetHistory(ec2, fleet.FleetId),
					instances: {},
					price: 0
				};
			}
		}));

		if (!Object.keys(fleets).length) {
			return "[*] No On-Demand fleets to process.";
		}

		console.log(`[+] Found ${Object.keys(fleets).length} EC2 Fleets to process.`);

	} catch (e) {
		console.log(e);
		throw new Error(`[!] Failed to retrieve On-Demand fleets: ${e}`);
	}

	// Associate instances with their fleets. EC2 Fleet stamps 'aws:ec2:fleet-id' on every
	// instance it launches, and the launch template adds our own CampaignId/HourlyRate tags.
	try {
		await Promise.all(Object.keys(settings.regions).map(async (region) => {
			const ec2 = new aws.EC2({ region });

			for (const instance of await getAllFleetInstances(ec2)) {
				const tags = tagsToMap(instance.Tags);
				const fleetId = tags['aws:ec2:fleet-id'];

				if (!fleetId || !fleets[fleetId]) {
					continue;
				}

				const endTime = (["pending", "running"].indexOf(instance.State?.Name) > -1) ?
					new Date().getTime() : getInstanceStopTime(instance);

				fleets[fleetId].instances[instance.InstanceId] = {
					// Shaped to match the spot pass so the dashboard renders both identically.
					Status: {
						Code: instance.State?.Name,
						Message: instance.StateTransitionReason || instance.StateReason?.Message || ""
					},
					State: instance.State?.Name,
					instanceType: instance.InstanceType,
					availabilityZone: instance.Placement?.AvailabilityZone,
					hourlyRate: parseFloat(tags.HourlyRate),
					history: {
						startTime: new Date(instance.LaunchTime).getTime(),
						endTime
					},
					price: 0
				};
			}
		}));
	} catch (e) {
		console.log(e);
		throw new Error(`[!] Failed to retrieve On-Demand instance statuses: ${e}`);
	}

	const promises = [];

	try {
		for (const fleetId of Object.keys(fleets)) {
			const fleet = fleets[fleetId];
			const ec2 = new aws.EC2({ region: fleet.region });

			const instanceCount = Object.keys(fleet.instances).length;
			const isDeleted = /^deleted/.test(fleet.FleetState);
			const fleetAge = new Date().getTime() - new Date(fleet.CreateTime).getTime();

			console.log(`[+] Found ${instanceCount} instances for ${fleetId} (${fleet.FleetState})`);

			const hasLiveInstances = Object.keys(fleet.instances).reduce((state, instanceId) => {
				return (["pending", "running"].indexOf(fleet.instances[instanceId].State) > -1) ? true : state;
			}, false);

			// Cost is calculated before anything else so that enforcement below always has
			// the best number available. On-Demand pricing is flat, so cost is just the rate
			// multiplied by uptime; Linux bills per-second with a 60 second minimum.
			let unpricedInstances = 0;

			for (const instanceId of Object.keys(fleet.instances)) {
				const instance = fleet.instances[instanceId];

				if (!instance.hourlyRate || !instance.history.startTime) {
					unpricedInstances++;
					continue;
				}

				const seconds = Math.max(60, (instance.history.endTime - instance.history.startTime) / 1000);

				instance.price = (seconds / 3600) * instance.hourlyRate;
				fleet.price += instance.price;

				console.log(`[*] Instance ${instanceId} up for ${seconds.toFixed(0)} seconds; estimated cost $${instance.price.toFixed(4)}`);
			}

			// An instance we can't price makes the total a lower bound, not a reason to stop
			// enforcing. Skipping the ceiling because of one missing tag would leave the
			// entire fleet uncapped, which is the opposite of what this function is for.
			if (unpricedInstances > 0) {
				console.log(`[!] Fleet ${fleetId} has ${unpricedInstances} instance(s) with no usable rate or launch time. Recorded cost is a lower bound.`);
			}

			// Nodes power themselves off when they finish; reap the fleet once they've all gone.
			if (!!instanceCount && !hasLiveInstances && !isDeleted) {
				promises.push(deleteFleet(ec2, fleetId).then(() => {
					console.log(`[+] Deleted ${fleetId} because all of its instances have stopped.`);
				}, (e) => {
					console.log(`[-] Unable to delete exhausted fleet ${fleetId}.`, e);
				}));
			}

			// A 'request' type fleet makes one attempt at capacity; On-Demand either has it
			// or it doesn't, and the answer comes back in seconds. A fleet still holding zero
			// instances well past launch is never going to get any, and without this it sits
			// marked RUNNING until ValidUntil expires - potentially hours of a campaign that
			// appears live and is doing nothing.
			if (!instanceCount && !isDeleted && fleetAge > NEVER_LAUNCHED_GRACE_MS) {
				console.log(`[!] Fleet ${fleetId} launched no instances within ${NEVER_LAUNCHED_GRACE_MS / 60000} minutes; deleting.`);

				promises.push(deleteFleet(ec2, fleetId).then(() => {
					console.log(`[+] Deleted ${fleetId} because it never obtained capacity.`);
				}, (e) => {
					console.log(`[-] Unable to delete never-launched fleet ${fleetId}.`, e);
				}));
			}

			// A fully deleted fleet with nothing running is a finished campaign.
			if (isDeleted && !hasLiveInstances) {
				const fleetState = (fleet.FleetState == "deleted") ? "COMPLETED" : "STOPPING";

				promises.push(editCampaignViaRequestId(fleetId, {
					active: false,
					price: fleet.price,
					spotRequestHistory: fleet.history,
					spotRequestStatus: fleet.instances,
					status: fleetState
				}).then(() => {
					console.log(`[+] Marked campaign of ${fleetId} as ${fleetState}`);
				}, (e) => {
					console.log(`[!] Failed attempting to update ${fleetId}`, e);
				}));

				// The per-campaign launch template has no further use once the fleet is done.
				promises.push(deleteLaunchTemplate(ec2, fleet.tags.CampaignId));

				continue;
			}

			promises.push(editCampaignViaRequestId(fleetId, {
				// A deleted fleet whose instances are still winding down is not an active
				// campaign. Writing 'true' here would resurrect one the user just cancelled,
				// because delete_campaign has already marked it inactive.
				active: !isDeleted,
				price: fleet.price,
				spotRequestHistory: fleet.history,
				spotRequestStatus: fleet.instances,
				status: isDeleted ? "STOPPING" : "RUNNING"
			}).then(() => {
				console.log(`[+] Updated price of fleet ${fleetId}`);
			}, (e) => {
				console.log(`[!] Failed attempting to update price for ${fleetId}`, e);
			}));

			// Exceeding either limit trips the ceiling, so the effective limit is the lower
			// of the two. A missing MaxCost tag leaves the deployment-wide limit in force.
			const maxCost = parseFloat(fleet.tags.MaxCost);
			const ceiling = Math.min(
				isNaN(maxCost) ? Infinity : maxCost,
				parseFloat(settings.campaign_max_price)
			);

			if (fleet.price > ceiling) {
				const critical = fleet.price > ceiling * 1.1;

				console.log(`Fleet ${fleetId} costs ${critical ? "CRITICALLY " : ""}exceed limits ($${fleet.price} > $${ceiling}); terminating.`);

				if (critical) {
					promises.push(criticalAlert(`EC2 Fleet ${fleetId} current price is: ${fleet.price}; Terminating.`));
				}

				// Issued once. Two concurrent deletes for the same fleet make the second one
				// fail, raising a spurious "failed to terminate" alert during the exact
				// incident where the alerting needs to be trustworthy.
				if (!isDeleted) {
					promises.push(deleteFleet(ec2, fleetId).then(() => {
						console.log(`Successfully terminated ${fleetId}`);
					}, (e) => {
						console.log(e);
						return criticalAlert(`Failed to terminate fleet ${fleetId} with cost $${fleet.price}`);
					}));
				}
			}
		}

		await Promise.all(promises);

	} catch (e) {
		console.log(e);
		throw new Error(`[!] Failed to update On-Demand instance costs: ${e}`);
	}

	return `[+] Reviewed [${Object.keys(fleets).length}] EC2 Fleets.`;
};

function tagsToMap(tags) {
	return (tags ?? []).reduce((acc, tag) => {
		acc[tag.Key] = tag.Value;

		return acc;
	}, {});
}

// Instances that are no longer running report when they stopped in StateTransitionReason,
// e.g. "User initiated (2024-01-01 12:00:00 GMT)". Fall back to now, which over-estimates
// cost rather than under-estimating it.
function getInstanceStopTime(instance) {
	const stamp = /\(([^)]+)\)/.exec(instance.StateTransitionReason ?? "")?.[1];
	const parsed = !!stamp ? Date.parse(stamp.replace(' GMT', ' UTC')) : NaN;

	return isNaN(parsed) ? new Date().getTime() : parsed;
}

async function getAllFleets(ec2, nextToken = null) {
	const data = await ec2.describeFleets({ MaxResults: 100, NextToken: nextToken }).promise();
	const fleets = data.Fleets ?? [];

	if (!data.NextToken) {
		return fleets;
	}

	return fleets.concat(await getAllFleets(ec2, data.NextToken));
}

// Every NPK On-Demand node carries a CampaignId tag from its launch template.
async function getAllFleetInstances(ec2, nextToken = null) {
	const data = await ec2.describeInstances({
		Filters: [{
			Name: "tag-key",
			Values: ["CampaignId"]
		}],
		MaxResults: 100,
		NextToken: nextToken
	}).promise();

	const instances = (data.Reservations ?? []).reduce((acc, reservation) => acc.concat(reservation.Instances ?? []), []);

	if (!data.NextToken) {
		return instances;
	}

	return instances.concat(await getAllFleetInstances(ec2, data.NextToken));
}

async function getFleetHistory(ec2, fleetId, nextToken = null) {
	try {
		const data = await ec2.describeFleetHistory({
			FleetId: fleetId,
			StartTime: new Date(new Date().getTime() - (1000 * 60 * 60 * 24)),
			NextToken: nextToken
		}).promise();

		let history = (data.HistoryRecords ?? []).map((entry) => {
			entry.Timestamp = new Date(entry.Timestamp).getTime() / 1000;

			return entry;
		});

		if (!!data.NextToken) {
			history = history.concat(await getFleetHistory(ec2, fleetId, data.NextToken));
		}

		return history;
	} catch (e) {
		// History is presentational only; never let it fail the costing pass.
		console.log(`[-] Unable to retrieve history for ${fleetId}.`, e);
		return [];
	}
}

async function deleteFleet(ec2, fleetId) {
	const result = await ec2.deleteFleets({
		FleetIds: [fleetId],
		TerminateInstances: true
	}).promise();

	if (result.UnsuccessfulFleetDeletions?.length) {
		throw new Error(JSON.stringify(result.UnsuccessfulFleetDeletions));
	}

	return result;
}

function deleteLaunchTemplate(ec2, campaignId) {
	if (!campaignId) {
		return Promise.resolve();
	}

	return ec2.deleteLaunchTemplate({
		LaunchTemplateName: `npk-${campaignId}`
	}).promise().then(() => {
		console.log(`[+] Deleted launch template for campaign ${campaignId}`);
	}, (e) => {
		// Already gone is the expected steady state after the first pass.
		if (e.code != "InvalidLaunchTemplateName.NotFoundException") {
			console.log(`[-] Unable to delete launch template for campaign ${campaignId}.`, e);
		}
	});
}

function criticalAlert(message) {
	return new Promise((success, failure) => {
		var sns = new aws.SNS({apiVersion: '2010-03-31', region: 'us-west-2'});

		sns.publish({
			Message: "NPK CriticalAlert: " + message,
			Subject: "NPK CriticalAlert",
			TopicArn: settings.critical_events_sns_topic
		}, function (err, data) {
			if (err) {
				console.log('CRITICAL ALERT FAILURE: ' + err);
				return failure(err);
			}

			console.log('CRITICAL ALERT: ' + message);
			return success(data);
		});
	});
};

function editCampaign(entity, campaign, values) {
	return new Promise((success, failure) => {
		values = aws.DynamoDB.Converter.marshall(values);

		Object.keys(values).forEach(function(e) {
			values[e] = {
				Action: "PUT",
				Value: values[e]
			};
		});

		var ddbParams = {
			Key: {
				userid: {S: entity},
				keyid: {S: "campaigns:" + campaign}
			},
			TableName: "Campaigns",
			AttributeUpdates: values
		};

		// console.log(JSON.stringify(ddbParams));

		db.updateItem(ddbParams, function (err, data) {
			if (err) {
				return failure(err);
			}

			return success(true);
		});
	});
}

// Campaigns are indexed by the fleet handle that started them, which is a Spot Fleet Request
// ID for spot campaigns and an EC2 Fleet ID for On-Demand ones.
function editCampaignViaRequestId(spotFleetRequestId, values) {
	return new Promise((success, failure) => {
		db.query({
			ExpressionAttributeValues: {
				':s': {S: spotFleetRequestId}
			},
			KeyConditionExpression: 'spotFleetRequestId = :s',
			IndexName: "SpotFleetRequests",
			TableName: "Campaigns"
		}, function (err, data) {
			if (err) {
				return failure(new Error("Error querying SpotFleetRequest table: " + err));
			}

			if (data.Items.length < 1) {
				return success(null);
			}

			data = aws.DynamoDB.Converter.unmarshall(data.Items[0]);
			console.log("[+] Found campaign " + data.keyid.split(':').slice(1));

			editCampaign(data.userid, data.keyid.split(':').slice(1), values).then((updates) => {
				success(updates);
			}, failure);
		});
	});
}

function getSpotRequestHistory(ec2, sfr, nextToken = null) {
	let history = [];

	return ec2.describeSpotFleetRequestHistory({
		SpotFleetRequestId: sfr,
		StartTime: "1970-01-01T00:00:00Z",
		NextToken: nextToken
	}).promise().then((data) => {

		history = history.concat(data.HistoryRecords);

		if (data.hasOwnProperty('NextToken')) {
			return getSpotRequestHistory(ec2, sfr, data.NextToken);
		}

		history = history.map((entry) => {
			entry.Timestamp = new Date(entry.Timestamp).getTime() / 1000;

			return entry
		});

		return history;
	});
}
