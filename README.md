# NPK - Increase your cred yield!

NPK is a distributed hash-cracking platform built entirely of serverless components in AWS including Cognito, DynamoDB, and S3. It was designed for easy deployment and the intuitive UI brings high-power hash-cracking to everyone.

![dashboard_progress](https://user-images.githubusercontent.com/143415/162669450-1b6da5bb-9e58-4cc5-941c-82b565f86b1b.png)

'NPK' is an initialism for the three primary atomic elements in fertilizer (Nitrogen, Phosphorus, and Potassium). Add it to your hashes to increase your cred yield!

## How it works

Let's face it - even the beastliest cracking rig spends a lot of time at idle. You sink a ton of money up front on hardware, then have the electricity bill to deal with. NPK lets you leverage extremely powerful hash cracking with the 'pay-as-you-go' benefits of AWS. For example, you can crank out 336 GH/s of NTLM for a mere $1/hr and scale it however you want. NPK was also designed to fit easily within the free tier while you're not using it! Without the free tier, it'll still cost less than $1 per MONTH to have online!

Every campaign is provisioned one of two ways: **Spot**, which is the cheapest way to crack but can be reclaimed by AWS at any moment, or **On-Demand**, which costs more per hour and cannot be interrupted. You choose per campaign, in the campaign builder.

## Features

### 1. Super easy install

Paste a one-liner into AWS CloudShell. Pretty easy.

```source <(curl -sL https://raw.githubusercontent.com/0x48756773/npk/main/cloudshell_install.sh)```

To deploy a different branch, export `NPK_BRANCH` first. The installer takes the branch from
the environment, so there is no separate script per branch:

```bash
export NPK_BRANCH=feature/on-demand-instances
source <(curl -sL https://raw.githubusercontent.com/0x48756773/npk/feature/on-demand-instances/cloudshell_install.sh)
```

Other overrides, all optional and all exported before sourcing: `NPK_REPO` (default
`0x48756773/npk`), `NPK_DIR` (default `/aws/mde/npk`), and `NPK_SKIP_DEPLOY` to set up the
environment without deploying.

![cloudshell_oneliner](https://user-images.githubusercontent.com/143415/160295789-7b4f21fa-4ac3-4900-b78a-7a974b9f48ac.png)

There are also [Step-by-step instructions](https://github.com/c6fc/npk/wiki/Step-by-step-Installation) if you want them.

### 2. Intuitive campaign builder

Take the trial-and-error out of complex attack types with the intuitive campaign builder. With a couple clicks you can create advanced campaigns that even advanced Hashcat users would struggle to emulate.

Pick your provisioning model at the top and everything below it re-derives from your account's entitlements for that model, so every GPU family, region, and instance size you're offered is one you can actually launch.

![campaign_builder](https://github.com/user-attachments/assets/4d35687a-225b-4b51-8ccd-1f36e6d2f94f)

### 3. Campaign price and coverage estimates

Take the guess-work out of your campaigns. See how far you'll get and how much it will cost *before* starting the campaign.

![coverage](https://user-images.githubusercontent.com/143415/156901016-a63b2ea1-fcf0-4a48-99c5-a1c6ab2e3221.png)

The estimate shows its working - instance count &times; instance type &times; hourly rate &times; hours - and tells you how much to trust it. On-Demand rates are published and fixed, so the estimate is the price. Spot rates move, so it isn't.

### 4. Spot or On-Demand provisioning

Pick how each campaign is provisioned right in the campaign builder. **Spot** is the cheapest way to crack and is the right default, but AWS can reclaim the instances at any time and end your campaign early. **On-Demand** costs more per hour and cannot be interrupted, which matters when a campaign has to finish on a schedule.

Toggling the model rebuilds the whole selection from scratch. Prices, quotas, available regions, and the set of instance sizes you can afford all differ between the two, so nothing carries over.

On-Demand rates are resolved from the AWS Pricing API at deploy time and baked into the console, which is what keeps the campaign builder responsive. The rate that actually governs spend is re-resolved server-side when the campaign launches, so a stale console price can't quietly raise your bill.

**Note:** Spot and On-Demand draw on *separate* AWS service quotas. A healthy Spot quota tells you nothing about your On-Demand quota, which is zero by default on many accounts. Check the 'Quota' page in the NPK console before planning an On-Demand campaign, and request an increase to *Running On-Demand G and VT instances* (or *Running On-Demand P instances*) if you need one.

### 5. Per-model quota visibility

The Quota page has its own Spot / On-Demand toggle and shows entitlements for one model at a time, because they are genuinely separate limits with separate quota codes. Regions where you hold no usable quota are called out rather than silently omitted.

If a model leaves you with nothing to launch, the campaign builder says so and links you to the Quota page instead of spinning forever - which is the usual first experience of On-Demand on a fresh account.

### 6. Full-fleet starts and the capacity queue

Every node works a slice of the keyspace determined by its position in the fleet, so a fleet that starts half-full doesn't just run slower - it works the wrong slices, and nothing reports an error. NPK won't do that.

For On-Demand campaigns, capacity is reserved *before* anything is launched. A reservation is per-availability-zone and all-or-nothing: AWS either holds the full instance count or refuses, and a refusal costs nothing. NPK walks the zones in your chosen region until one takes the whole request, then launches the fleet directly into that reservation so it fills completely and at once.

If no zone has room, the campaign is parked instead of launched. It sits in the queue costing nothing while NPK retries every minute for up to 6 hours, and starts the moment capacity appears. You'll see it move through these states on the dashboard:

| Status | Meaning |
|---|---|
| Waiting for capacity | Parked in the queue. Nothing is running and nothing is being billed. |
| Reserving capacity | A launch attempt is in flight right now. |
| No capacity available | The campaign waited out its deadline, or its fleet never filled. It was ended rather than run incorrectly. |

Cancelling a queued campaign stops the retries immediately.

### 7. Max price enforcement and runaway instance protection

GPU instances are expensive. Runaway GPU instances are EXTREMELY expensive. NPK will enforce a maximum campaign price limit, and was designed to prevent runaway instances even with a complete failure of the management plane.

On-Demand campaigns are launched as EC2 Fleets with an expiry attached, so AWS itself terminates the instances when the campaign's time or budget runs out &mdash; even if every Lambda in the account stops running. That expiry is bounded by whichever runs out first: the duration you asked for, or the point at which the fleet would burn through the campaign's cost ceiling. A budget too small to buy even a minute of runtime is rejected up front, before anything is created.

Reserved capacity bills at the full On-Demand rate whether or not anything is running in it, so NPK releases it on every path that ends a campaign - completion, cancellation, teardown, or a failed launch. Cancelling from the console stops the meter right away rather than waiting for the next monitor pass.

The monitor also reaps On-Demand fleets that never reached the capacity their campaign was sized for, marking them 'No capacity available' rather than letting a partly-filled fleet bill at full rate for a run that can't be correct. The nodes carry a backstop for the same condition: a node that can't establish its position in a complete fleet shuts itself down instead of guessing.

Spot and On-Demand campaigns are tracked by independent monitor passes, so a failure in one can never leave the other's cost ceiling unenforced.

### 8. Multi-Tenancy & SAML-based single sign-on

NPK supports multiple users, with strict separation of data, campaigns, and results between each user. It can optionally integrate with SAML-based federated identity providers to enable large teams to use NPK with minimal effort.

![user_administration](https://user-images.githubusercontent.com/143415/156901873-6c89bb50-5268-4382-aebd-e45ee5ff2f9f.png)

### 9. Data lifecycle management

Configure how long data will stay in NPK with configurable lifecycle durations during installation. Hashfiles and results are automatically removed after this much time to keep things nicely cleaned up.

## Choosing between Spot and On-Demand

|  | Spot | On-Demand |
|---|---|---|
| Cost per hour | Lowest | Higher, fixed |
| Interruption | AWS can reclaim at any time | Never |
| Price stability | Rates move; final cost varies | Published rate; the estimate is the price |
| Account quota | *All G and VT Spot Instance Requests* | *Running On-Demand G and VT instances* (P families have their own limit) |
| Capacity behaviour | Fleet fills as capacity allows | Capacity reserved up front; campaign queues if none is available |
| AWS API | Spot Fleet Request | EC2 Fleet + Capacity Reservation |

Spot remains the default and the right choice for most work. Reach for On-Demand when a campaign has to finish on a schedule, when Spot capacity for your chosen GPU family keeps failing, or when an interruption would cost you more than the rate difference.

### Requesting an On-Demand quota increase

New AWS accounts are typically entitled to zero On-Demand GPU instances. From the AWS console, go to **Service Quotas &rarr; AWS services &rarr; Amazon EC2** in the region you want to run in, then request an increase to:

- **Running On-Demand G and VT instances** (`L-DB2E81BA`) - covers the G4, G5, G6, and G6e families
- **Running On-Demand P instances** (`L-417A185B`) - covers P4d and other A100-class instances

Quotas are denominated in vCPUs rather than instances, and are per-region. Run `npm run update` once an increase is granted so NPK picks up the new entitlements.

## Easy Install

**ProTip:** To keep things clean and distinct from other things you may have in AWS, it's STRONGLY recommended that you deploy NPK in a fresh account. You can create a new account easily from the 'Organizations' console in AWS. **By 'STRONGLY recommended', I mean 'seriously don't install this next to other stuff'.**

**Note: If you have an older version of NPK that you deployed without the one-liner, you'll need to destroy it before installing the new version**

1. Log into the AWS Console for the account you want to deploy to.
2. Click the AWS CloudShell button in the top right corner.
![cloudshell_icon](https://user-images.githubusercontent.com/143415/156901055-5107d4b2-c5b4-4ca5-8454-57e7504e2316.png)

3. Paste in the one-liner: `source <(curl -sL https://raw.githubusercontent.com/0x48756773/npk/main/cloudshell_install.sh)`
4. Use the wizard to complete the configuration

When the deploy finishes, you'll be dropped to a custom prompt, which indicates that NPK is deployed and CloudShell is connected to it.

![deployed_prompt](https://user-images.githubusercontent.com/143415/160296855-d2b5a383-445f-44a7-8a06-0051ad215536.png)

If you said 'no' at the end of the wizard, you can run `npm run deploy` from this prompt to finish the deployment.

See https://github.com/c6fc/npk/wiki/Detailed-NPK-Settings for more details about advanced configurations, or https://github.com/c6fc/npk/wiki/Configuring-SAML-SSO for help configuring SAML SSO.

The deploy collects both Spot and On-Demand quotas for every configured region, resolves published On-Demand rates from the Pricing API, and creates the `AWSServiceRoleForEC2Fleet` service-linked role if the account doesn't already have one. None of these are fatal if they fail - a region NPK can't price, or can't read a quota for, is simply not offered for that model.

## Connect to an existing installation

**Note: If you have an older version of NPK that you deployed without the one-liner, you'll need to destroy it before installing the new version**

To connect to an existing NPK installation (which is needed to modify or uninstall NPK), log into the AWS account where NPK resides, click the CloudShell icon, and paste in the one-liner:

```source <(curl -sL https://raw.githubusercontent.com/0x48756773/npk/main/cloudshell_install.sh)```

CloudShell will now connect to NPK (which may take a minute or two), after which you'll drop to a new prompt that looks like this:

![deployed_prompt](https://user-images.githubusercontent.com/143415/160296855-d2b5a383-445f-44a7-8a06-0051ad215536.png)

You're now connected to your NPK installation. This can be performed by any user in the AWS account with admin rights, and can be performed in any region.

## Modify Install

You can change the settings of an install without losing your existing campaigns. Use the instructions above to connect to your NPK installation, then edit `npk-settings.json` as necessary and run `npm run update`. It's that easy!

```sh
cloudshell-user$ source <(curl -sL https://raw.githubusercontent.com/0x48756773/npk/main/cloudshell_install.sh)
@c6fc/npk> vim npk-settings.json
< ... change your settings however you need >
@c6fc/npk> npm run update
```

Run `npm run update` after an AWS quota increase as well - quotas and On-Demand prices are resolved at deploy time and baked into the console.

## Uploading your own dictionaries and rule files

Once NPK has been deployed, administrative users can use the NPK console to upload wordlists and rule files using the 'Dictionary Management' link in the sidebar. NPK supports plain-text and gzipped dictionaries.

![upload_dictionaries](https://user-images.githubusercontent.com/143415/156901465-6e906177-e9fa-4189-8cda-0735813d02c0.png)

## Uninstall

You can completely turn down NPK and delete all of its data from AWS very easily. Just attach your CloudShell to NPK, then run `npm run destroy`:

```sh
cloudshell-user$ source <(curl -sL https://raw.githubusercontent.com/0x48756773/npk/main/cloudshell_install.sh)
@c6fc/npk> npm run destroy
```

# Official Discord Channel

Have questions, need help, want to contribute or brag about a win? Come hang out on Discord!

[![Official c6fc Discord](https://discordapp.com/api/guilds/825770240309985310/widget.png?style=banner3)](https://discord.gg/w4G5k92czX)
