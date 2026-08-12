# NPK — Project Context

NPK is a serverless distributed hash-cracking platform on AWS (Cognito + DynamoDB + S3 +
Lambda + GPU EC2 instances). It is deployed with Terraform configs generated from Jsonnet
via [Sonnetry](https://github.com/c6fc/sonnetry).

This file is orientation for future work. See `README.md` for user-facing docs.

---

## Architecture orientation

### Deploy pipeline

```
npk-settings.json ─┐
                   ├─> bin/index.js ─> validatedSettings (extVar)
AWS live lookups ──┘                        │
  (quotas, AZs, instance                    v
   offerings, On-Demand prices)      terraform.jsonnet + jsonnet/*.libsonnet
                                            │
                                            ├─> render-npk/*.tf.json ─> terraform apply
                                            ├─> lambda_functions/*/accountDetails.json
                                            ├─> site-content/angular/npk_config.js
                                            └─> lambda_functions/execute_campaign/userdata.sh
```

`bin/index.js` performs live AWS discovery **at deploy time** and hands the results to
Jsonnet as `validatedSettings`. Anything expensive or slow-changing (service quotas, AZ
lists, per-region instance offerings, On-Demand prices) is resolved once here and baked into
generated artifacts rather than looked up at runtime.

**Generated files are gitignored.** `npk_config.js`, `accountDetails.json`, `userdata.sh`
and the `ENVVARS` files do not exist in a fresh clone — they appear at deploy. Any change to
the shape of these files requires a full `npm run deploy` / `npm run update`, **not** an
`aws s3 sync` of `site-content/`.

### Campaign lifecycle

```
create_campaign   POST /v1/userproxy/campaign
                  validates + writes manifest.json to S3 and a row to DynamoDB
                        │
execute_campaign  POST .../campaign/{id}/start
                  launches the fleet, stores the fleet handle on the campaign row
                        │
spot_monitor      EventBridge, every 1 minute
                  costs the running fleets, enforces the price ceiling, reaps finished ones
                        │
delete_campaign   DELETE .../campaign/{id}
                  stops a running campaign, or soft-deletes a finished one
```

### Key data-model facts

- Campaigns live in the `Campaigns` DynamoDB table, keyed `userid` / `keyid`, where `keyid`
  is `campaigns:<uuid>` for the campaign row and `<uuid>:nodes:<instance>:<ts>` for status
  reports.
- The **`spotFleetRequestId` attribute is the generic fleet handle**, not a spot-only field.
  It holds a Spot Fleet Request ID for spot campaigns and an **EC2 Fleet ID** for On-Demand
  ones. It backs the `SpotFleetRequests` GSI, which is how the monitor and the interrupt
  catcher find a campaign from an AWS-side identifier. The name was deliberately left alone
  to avoid a table migration — do not "fix" it without also migrating the GSI.
- `provisioningModel` is `"spot"` or `"on-demand"`. It is absent on campaigns created before
  this feature; **every read site treats absent as `"spot"`**.

### Node keyspace splitting (fragile — read before touching `userdata.tpl`)

Each GPU node decides which slice of the keyspace to work on from its position in the fleet:

```bash
INSTANCECOUNT   # how many instances the fleet has
INSTANCENUMBER  # this instance's 1-based index in the sorted instance list
```

These come from enumerating the fleet at boot. If the enumeration returns one instance when
there are really four, **every node grinds the same slice** — you pay 4× for 1× coverage and
nothing anywhere reports an error. This is the highest-consequence silent failure in the
system. The two models use different tag keys and different describe calls:

| | Spot Fleet | EC2 Fleet (On-Demand) |
|---|---|---|
| Instance tag | `aws:ec2spot:fleet-request-id` | `aws:ec2:fleet-id` |
| Enumeration | `describe-spot-fleet-instances` | `describe-fleet-instances` |

`userdata.tpl` renames whichever tag is present to a shell-safe name (`SpotFleet` / `Fleet`),
then branches on which one is set.

### Jsonnet / template gotchas

- `templates/*.tpl` are Terraform `template_file` inputs. `${foo}` is a Terraform
  interpolation; to emit a literal shell `${foo}` you must write `$${foo}`. Bare `$foo`
  is safe.
- Jsonnet supports `//`, `#` and `/* */` comments. `.json` files under `jsonnet/` are
  imported as data and must stay strict JSON.
- There is no offline way to validate the full render: `terraform.jsonnet` reads
  `std.extVar('validatedSettings')`, which only exists once `bin/index.js` has authenticated
  to AWS. Syntax review is manual.

---

## Current work: On-Demand provisioning

**Branch:** `feature/on-demand-instances` (branched from `main` @ `36ccf2c`)
**Status:** code complete, **not yet validated against AWS**, uncommitted.

### Why

The platform was built around Spot. GPU spot capacity has become unreliable enough that
quarterly password-cracking exercises can no longer depend on it. Campaigns need an option
that will not be interrupted, even at higher cost.

### Design decision: EC2 Fleet, not `RunInstances`

On-Demand campaigns launch through **`ec2.createFleet`** with
`DefaultTargetCapacityType: "on-demand"`, from a per-campaign launch template.

The alternative — plain `runInstances` — is roughly 40 lines shorter and needs no launch
template. It was rejected because it gives up `ValidUntil` + `TerminateInstancesWithExpiration`.
That pair is what makes README feature #5 true: AWS itself terminates the instances when the
campaign expires, so runaway protection survives a total failure of the management plane. On
GPU instances at On-Demand rates, resting that guarantee entirely on a Lambda that runs every
minute is not an acceptable trade.

EC2 Fleet also maps almost 1:1 onto the existing spot call sites
(`describeFleets` / `describeFleetHistory` / `deleteFleets`), which kept the monitor rework
containable.

### Design decision: On-Demand prices resolved at deploy time

Rates are fetched by `bin/index.js` and baked into `npk_config.js` as the `ONDEMANDPRICES`
constant, alongside `QUOTAS` and `FAMILIES`.

The original plan was to call the Pricing API from the browser (the Cognito authenticated
role already grants `pricing:*`). That was changed because it depends on
`api.pricing.us-east-1.amazonaws.com` returning CORS headers — unverified, and a silent empty
price panel if wrong. Baking also removes ~95 API calls from page load.

The trade-off is staleness: displayed prices are as fresh as the last `npm run update`. This
is safe because **the rate that governs actual spend is re-resolved server-side by
`execute_campaign` at launch** and stamped onto each instance as an `HourlyRate` tag. A stale
estimate cannot cause an overrun; it can only make the estimate slightly wrong.

### What changed

**Deploy / infrastructure**

| File | Change |
|---|---|
| `jsonnet/gpu_instance_families.json` | `quotaCode` → `spotQuotaCode`, added `onDemandQuotaCode` (G/VT `L-DB2E81BA`, P `L-417A185B`) |
| `bin/index.js` | fetches both quota sets; new `getOnDemandPrices()` (chunked, throttle-tolerant, non-fatal); creates the `ec2fleet.amazonaws.com` SLR; a single failed quota lookup no longer drops the whole region |
| `terraform.jsonnet` | IAM for `CreateFleet` / `DeleteFleets` / `Describe*Fleet*` / launch templates / `TerminateInstances` / `pricing:GetProducts`; threads `onDemandPrices` into the site config |
| `jsonnet/ec2_iam_roles.libsonnet` | node role gains `ec2:DescribeFleetInstances` |
| `jsonnet/vpc.libsonnet` | subnets set `map_public_ip_on_launch` (see caveat below) |
| `templates/npk_config.tpl` | new `ONDEMANDPRICES` constant |
| `templates/userdata.tpl` | dual-model fleet enumeration; strips colon-bearing tag keys |

**Lambdas**

| File | Change |
|---|---|
| `create_campaign` | validates `provisioningModel`; selects the quota code per model; persists the model |
| `execute_campaign` | branches to launch template + `createFleet`; resolves the On-Demand rate from the Pricing API; bounds fleet life by cost *and* duration; rejects budgets too small to buy a minute |
| `spot_monitor` | split into independent `processSpotFleets()` / `processOnDemandFleets()` passes joined by `Promise.allSettled`; On-Demand costing is rate × uptime |
| `delete_campaign` | branches to `deleteFleets`; deletes the launch template; "mark cancelled" extracted to one helper used on every exit path |

**Front end**

| File | Change |
|---|---|
| `pricingSvc.js` | `getFamilyPricing(family, model)` dispatcher; `getFamilyOnDemandPrices()`; `quotaCodeFor()` |
| `npkMainCtrl.js` | `provisioningModel` + `setProvisioningModel()`; model-aware `getInstanceOptions()`; `provisioningModel` on the submitted order; quota-page model helpers |
| `new-campaign.html` | Spot/On-Demand toggle; price breakdown showing how the estimate is built; empty state when quota is zero |
| `quota.html` | per-model quota toggle |
| `dashboard.html`, `campaign-management.html` | spot-specific copy made conditional |

### Bugs found and fixed along the way

These were pre-existing on `main`, encountered while working in the same code paths:

1. **The quota check has never fired.** `create_campaign` read `variables.gQuota` /
   `variables.pQuota`, which are not in the Lambda's environment, *and* the vCPU map stored
   `[gpuCount, vcpuCount]` arrays rather than numbers. The comparison was
   `undefined < NaN` — always false. **Expect campaigns that used to be accepted to start
   being rejected.** That is the check working for the first time, but it will look like a
   regression if it surprises someone.
2. **`execute_campaign` never awaited its subnet enumeration.** The `describeSubnets`
   promises were pushed to an array that was never `Promise.all`'d. `availabilityZones` was
   populated only by luck, via the unrelated `await`s that happen to follow before it is
   read. Now awaited inside the existing try/catch, so failures surface instead of producing
   launch specs with `undefined` subnets.
3. `getInstanceOptions()` did not `return` the inner promise from its `.map()`, so
   `await Promise.all(...)` resolved immediately and never waited for prices.
4. `spot_monitor` referenced an undefined `promiseDetails` in one error handler and an
   undefined `cb` in another — both would have thrown `ReferenceError` if reached.
5. `delete_campaign` had a `cancallation` typo and a `respond(404, "msg", false)` call
   missing its headers argument.
6. `delete_campaign` ended with unreachable code referencing an undefined
   `spotFleetRequest`.

### Review findings addressed

A `code-reviewer` pass over the backend diff (focused on the cost kill-switch) returned
approve-with-fixes. All findings were confirmed against the code and resolved:

- **A cancelled campaign could be marked active again.** The monitor's fallback branch wrote
  `active: true` unconditionally. When `describeFleets` reports `deleted_terminating` while
  `describeInstances` still shows an instance running — a plausible race across two separate
  API calls — this overwrote the `active: false` / `CANCELLED` that `delete_campaign` had
  just written. Now `active: !isDeleted`.
- **Fleets that never obtained capacity were never reaped.** The reap condition required
  `instanceCount > 0`, so a fleet that launched nothing sat marked `RUNNING` until
  `ValidUntil` expired, potentially hours. Now deleted after a 15-minute grace period
  (`NEVER_LAUNCHED_GRACE_MS`). The grace period matters: a fleet legitimately holds zero
  instances for the first seconds after creation, so reaping immediately — as first
  suggested — would kill healthy campaigns. 15 minutes is safe because On-Demand capacity
  resolves in seconds, unlike spot.
- **One unpriceable instance disabled the ceiling for its whole fleet.** A missing
  `HourlyRate` tag set `badInstance`, which `continue`d past both the DB update *and* cost
  enforcement. Now the fleet is enforced on the sum of what can be priced, with the shortfall
  logged. Partial enforcement is strictly better than none in the money path.
- **Launch template leak on an unguarded throw.** `fleetParams` construction sat between two
  guarded blocks and dereferenced `variables.availabilityZones[manifest.region]`. A manifest
  naming a dropped region threw out of the handler: no response to the caller, and the
  template stranded. Now checked explicitly, with cleanup routed through a shared
  `deleteLaunchTemplateQuietly()` helper used on every abort path.
- **Double-delete on cost overage.** Exceeding both the 100% and 110% thresholds in one pass
  issued two concurrent `deleteFleets` calls; the second failed and raised a spurious
  "failed to terminate" critical alert during exactly the incident where alerting needs to be
  trustworthy. Now one delete, with the critical alert raised separately.

One reviewer observation was **not** acted on: `fleet.instances.length` in the *spot* reduce
is dead (it is a plain object, not an array). It is pre-existing, faithfully preserved, and
changing it would alter spot behaviour — out of scope for this branch, but worth a look
separately.

### Caveat: the VPC subnet change

`jsonnet/vpc.libsonnet` now sets `map_public_ip_on_launch: true`. This was **not** cosmetic
and is the one change that touches existing spot infrastructure.

EC2 Fleet passes the subnet as a launch template *override*, which AWS treats as mutually
exclusive with declaring a network interface in the template — and the network interface is
what was assigning public IPs. Without this, On-Demand nodes launch with no route to the
internet and hang at boot. It is an in-place attribute update (no resource replacement), and
spot launch specs are unaffected because they set `AssociatePublicIpAddress` explicitly.

---

## Future work

### 1. Validate against AWS — blocking, must come first

Nothing in this branch has run against a real account. Everything passes syntax checking and
the wiring is consistent, but the EC2 Fleet call shapes, the `aws:ec2:fleet-id` tag key, and
the node-side `describe-fleet-instances` enumeration are written from API knowledge, not from
an observed response.

Suggested first run, in a test account:

1. `npm run update`, confirm `npk_config.js` contains a populated `ONDEMANDPRICES`.
2. Smallest available instance (`g4dn.xlarge`), **`instanceCount: 2`**, short duration.
   Two instances is the minimum that proves keyspace splitting; one instance will pass even
   if the enumeration is broken.
3. On the nodes, check `/root/envvars` for `INSTANCECOUNT=2` and distinct `INSTANCENUMBER`
   values. This is the single most important thing to verify.
4. Confirm the campaign costs correctly in the dashboard and that the price rises at roughly
   `rate × count` per hour.
5. Let one campaign hit its cost ceiling and confirm the monitor deletes the fleet.
6. Cancel another mid-run from the UI and confirm both the fleet and the launch template
   are gone.
7. Confirm a **spot** campaign still works end to end — the monitor was restructured.

Two additional cases are now worth exercising, since they cover the review fixes:

8. Start an On-Demand campaign in a region with no capacity (or request an absurd instance
   count) and confirm it is deleted and marked done after ~15 minutes rather than sitting at
   `RUNNING`.
9. Cancel a campaign from the UI and watch the *next* monitor pass. The campaign must stay
   `CANCELLED` / inactive — this is the race the `active: !isDeleted` fix addresses, and it
   only shows up in the window where instances are still terminating.

### 2. Known gaps, roughly by value

- **Launch-template orphans.** Templates are deleted when the monitor sees a fleet reach a
  terminal state and when `delete_campaign` runs. A fleet that ages past the monitor's 24h
  window without reaching a terminal state leaves its template behind. Harmless and free,
  but the per-region cap is 5000. A sweeper for templates tagged `CampaignId` older than N
  days would close this.
- **Revisit `campaign_max_price`.** On-Demand g6e/p4d run 3–5× spot. The default of `50` will
  truncate On-Demand campaigns that would have completed on spot. This is a per-deployment
  setting in `npk-settings.json`, not a code change.
- **`compression_pipe` still launches a spot fleet** for dictionary compression
  (`lambda_functions/compression_pipe/main.js:182`). Deliberately out of scope — it is a
  short internal job where interruption is cheap and simply retried. Convert only if spot
  capacity starts failing these too.
- **On-Demand price staleness.** Prices refresh only on `npm run update`. If this becomes a
  problem, the fix is a small authenticated API endpoint returning live rates, not a browser
  call to the Pricing API (see the design decision above).
- **`spot_interrupt_catcher` is unchanged and should stay that way.** On-Demand instances
  never emit interruption warnings, so it correctly never fires for them.
- **Dead code:** `$scope.quotaFor()` in `npkMainCtrl.js` (campaign controller) has no
  references in any view. Left in place; not related to this work.

### 3. Operational note for the first quarterly run

**On-Demand GPU quota is a separate limit and defaults to zero or near-zero on many
accounts.** It is independent of whatever spot quota the account already has, and an increase
request can take days. This is the most likely thing to block a scheduled exercise regardless
of whether the code is ready. Check the Quota page in the NPK console — it now has a
Spot/On-Demand toggle — and file the increase for *Running On-Demand G and VT instances*
(`L-DB2E81BA`) or *Running On-Demand P instances* (`L-417A185B`) well ahead of time.

---

## Conventions worth preserving

- Absent `provisioningModel` means spot, everywhere. Keep new read sites consistent.
- The two monitor passes are deliberately independent. A failure in one must never prevent
  the other from enforcing its cost ceiling — do not merge them or chain them.
- Cost estimates round *up* (unknown instance stop times fall back to "now"). When in doubt,
  over-estimate cost; the failure mode is a campaign ending early rather than a runaway bill.
- Spot behaviour was intentionally left byte-for-byte identical wherever possible. When
  changing shared code, prefer adding a branch over modifying the spot path.
