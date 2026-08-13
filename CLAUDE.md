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

### CloudShell bootstrap

`cloudshell_install.sh` lives in the repo and is fetched directly from GitHub raw rather
than from `npkproject.io`, so the installer and the code it deploys are always the same
revision. Repo, branch and target directory come from `NPK_REPO` / `NPK_BRANCH` / `NPK_DIR`,
which replaces the old practice of maintaining a separate `cloudshell_install_dev.sh`.

The script is **sourced, not executed** — it sets `PS1` and leaves the shell inside the repo
directory. It therefore must never call `exit` or `set -e`; either would kill the user's
CloudShell session. Failure paths `return` instead.

### Campaign lifecycle

```
create_campaign   POST /v1/userproxy/campaign
                  validates + writes manifest.json to S3 and a row to DynamoDB
                        │
execute_campaign  POST .../campaign/{id}/start
                  On-Demand: reserves capacity, then launches from a launch template
                  Spot:      launches a spot fleet directly
                  stores the fleet handle on the campaign row
                        │
                        ├─ no capacity? ─> AWAITING_CAPACITY ──┐
                        │                                       │
spot_monitor      EventBridge, every 1 minute                   │
                  costs the running fleets, enforces the price  │
                  ceiling, reaps finished ones, and re-invokes  │
                  execute_campaign for parked campaigns ────────┘
                        │
delete_campaign   DELETE .../campaign/{id}
                  stops a running campaign, releases its reservation, or
                  soft-deletes a finished one
```

### Campaign statuses

`AVAILABLE` → `AWAITING_CAPACITY` ⇄ `ACQUIRING_CAPACITY` → `STARTING` → `RUNNING` →
`STOPPING` → `COMPLETED`, with `CANCELLED` and `INSUFFICIENT_CAPACITY` as terminal exits.

The UI renders the raw token through `$scope.statusLabel()` on `npkMainCtrl`, defined on the
parent scope so both the dashboard and campaign management inherit it. New statuses need an
entry there or they surface to users as bare `SCREAMING_SNAKE`.

### Key data-model facts

- Campaigns live in the `Campaigns` DynamoDB table, keyed `userid` / `keyid`, where `keyid`
  is `campaigns:<uuid>` for the campaign row and `<uuid>:nodes:<instance>:<ts>` for status
  reports.
- The **`spotFleetRequestId` attribute is the generic fleet handle**, not a spot-only field.
  It holds a Spot Fleet Request ID for spot campaigns and an **EC2 Fleet ID** for On-Demand
  ones. It backs the `SpotFleetRequests` GSI, which is how the monitor and the interrupt
  catcher find a campaign from an AWS-side identifier. The name was deliberately left alone
  to avoid a table migration — do not "fix" it without also migrating the GSI.
- The same attribute carries **sentinels** when there is no fleet: `"awaiting-capacity"` while
  a campaign is queued, and `"expired:<uuid>"` once it gives up. The first is deliberate —
  every parked campaign shares it, so the monitor finds them all with **one GSI query instead
  of a table scan**. The cost is that a query for that key returns an arbitrary one of them,
  so `editCampaignViaRequestId()` explicitly refuses the sentinel.
- `provisioningModel` is `"spot"` or `"on-demand"`. It is absent on campaigns created before
  this feature; **every read site treats absent as `"spot"`**.
- `capacityReservationId` holds the On-Demand Capacity Reservation backing the campaign, or
  `"<none>"`. `capacityWaitUntil` is the epoch-ms deadline after which a queued campaign gives
  up; it is set once, on the first park, so retrying never extends it. `capacityClaimedAt`
  backs the retry lease described below.

### Cost tracking is recomputed, not accumulated

`spot_monitor` recalculates a campaign's price from scratch on every pass, out of APIs that
forget at different rates: terminated instances leave `DescribeInstances` after ~1 hour, while
the fleet itself lingers for 24. Once the instances age out the recompute yields **zero**.

`editCampaignViaRequestId()` therefore clamps: a recomputed price lower than the stored one is
discarded as stale, and an empty instance map never overwrites a populated one. Only the
*stored* figure is clamped — ceiling enforcement still runs on the freshly computed value, so
the kill switch is unaffected. Without this a finished campaign's real cost is overwritten
with `$0.00` every minute for a day.

### Node keyspace splitting (fragile — read before touching `userdata.tpl`)

Each GPU node decides which slice of the keyspace to work on from its position in the fleet:

```bash
INSTANCECOUNT   # how many instances the fleet has
INSTANCENUMBER  # this instance's 1-based index in the sorted instance list
```

These come from enumerating the fleet at boot. If the enumeration returns one instance when
there are really four, **every node grinds the same slice** — you pay 4× for 1× coverage and
nothing anywhere reports an error. This is the highest-consequence silent failure in the
system, and **it has actually happened in production** — see the incident below.

The two models use different tag keys and different describe calls:

| | Spot Fleet | EC2 Fleet (On-Demand) |
|---|---|---|
| Instance tag | `aws:ec2spot:fleet-request-id` | `aws:ec2:fleet-id` |
| Enumeration | `describe-spot-fleet-instances` | `describe-fleet-instances` |

`userdata.tpl` renames whichever tag is present to a shell-safe name (`SpotFleet` / `Fleet`),
then branches on which one is set.

**Enumerating once at boot is not safe, and the code no longer does it.** Fleets fill
asynchronously. A node that boots early sees a short list; and because the list is sorted by
instance ID — which is random — a node that boots *later* can still sort *first*. Two nodes
then both compute position 1 and grind identical keyspace.

`execute_campaign` bakes the requested count into userdata as `{{INSTANCECOUNT}}`, and each
node polls until the fleet reaches it (15s interval, 10 minute ceiling) before computing its
slice. Every node therefore divides the same complete set. Both the count and the position are
read from a single listing so they cannot disagree. Two paths `abort_node` rather than guess:
the fleet never filling, and the node not finding itself in its own fleet listing — the latter
previously fell through to the wrapper's `|| 1` default, which is another route to two nodes
on slot 1.

The timings are load-bearing and interlock with the monitor:

| Guard | Where | Value |
|---|---|---|
| Node waits for a full fleet | `userdata.tpl` `FLEET_WAIT_SECONDS` | 600s |
| Monitor kills an under-capacity fleet | `spot_monitor` `CAPACITY_GRACE_MS` | 8 min |

The monitor's grace is deliberately **shorter** than the node's wait, so the monitor is what
ends a doomed campaign and records a reason for it. The node's wait is only the backstop for
when the monitor can't run. Reversing that ordering makes campaigns die with no explanation.

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
**Status:** first live run attempted 2026-08-12; it failed, and the fixes it prompted are
code complete but **not yet re-validated against AWS**.

### Why

The platform was built around Spot. GPU spot capacity has become unreliable enough that
quarterly password-cracking exercises can no longer depend on it. Campaigns need an option
that will not be interrupted, even at higher cost.

### The 2026-08-12 incident — read this before changing the launch path

The first real On-Demand campaign (4 × `g6e.xlarge`, us-west-2, 2h, TrueCrypt RIPEMD160)
cracked nothing and reported `$0.00`. Three independent faults, all now fixed:

1. **Only 2 of 4 instances ever launched.** `g6e.xlarge` capacity was exhausted across every
   AZ in the region. One instance launched immediately in us-west-2b, a second 18 minutes
   later in us-west-2a, and the fleet spent the rest of its life cycling
   `allLaunchTemplatesTemporarilyBlacklisted`.
2. **The keyspace split silently collapsed.** Node A booted alone and took the *whole*
   keyspace (`node 1 of 1`). Node B booted 18 minutes later, saw two instances, and — because
   `i-066…` sorts before `i-0e4…` — also took position 1 (`node 1 of 2`, `--skip 0`). Node B's
   entire 1h42m of work was a strict subset of node A's. Unique coverage from two GPUs was
   32.71%.
3. **Cost read `$0.00`** because the monitor recomputes price from scratch and the terminated
   instances had aged out of `DescribeInstances`. Roughly $6.92 was actually billed. The
   ceiling was never exercised; `ValidUntil` is what ended the run.

The job needed **~5.66 GPU-hours** (measured independently from both nodes' progress rates).
Four correctly-split nodes would have finished in ~1.41h for ~$10.51, inside both the 2h
window and the $14.89 cap. The plan was sound; provisioning was not.

The lesson worth carrying: **a partial fleet is worse than no fleet.** It bills at full rate
for a run that cannot cover the keyspace, and nothing reports an error.

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

### Design decision: capacity is reserved before the fleet is created

`execute_campaign` calls **`CreateCapacityReservation`** before it creates anything else, and
launches the fleet with the launch template targeting that reservation
(`CapacityReservationTarget`, `InstanceMatchCriteria: "targeted"`). A reservation is per-AZ and
all-or-nothing, so walking the region's zones is a **free probe** — a refusal costs nothing —
and a success means the capacity is *held* rather than raced for. That is what makes the fleet
fill completely and at once, which is what makes the keyspace split trustworthy.

Two alternatives were considered and rejected:

- **`OnDemandOptions.MinTargetCapacity` + `SingleAvailabilityZone`** expresses all-or-nothing
  directly, and is cheaper (no reservation billing). AWS supports all three of
  `MinTargetCapacity` / `SingleAvailabilityZone` / `SingleInstanceType` **only for
  `Type: "instant"` fleets**, and an instant fleet reaches a terminal state immediately, so
  `ValidUntil` no longer terminates anything. That trades away the kill switch — the same
  reason `RunInstances` was rejected.
- **Sizing the campaign down to whatever is available.** Easy, but it doesn't solve the
  problem: the user asked for 4 nodes because that is what finishes the job. Two nodes over
  2h covers ~70% however correctly it's split. It converts a silent failure into an honest
  one without producing a result.

Because `Type: "request"` is retained, `ValidUntil` + `TerminateInstancesWithExpiration` still
bound the fleet exactly as before.

**The cost caveat is the main risk in this design.** A reservation bills at the full On-Demand
rate from creation, occupied or not. Release is wired into every terminal path — monitor reap,
monitor under-capacity, `delete_campaign`, and all four abort paths in `execute_campaign` — and
is found by `CampaignId` **tag** rather than stored ID, so a campaign whose DB write failed is
still swept. Every reservation also carries `EndDateType: "limited"` as a last backstop, so a
fully orphaned one self-terminates instead of billing indefinitely. **Any new exit path from
the On-Demand launch flow must release the reservation.**

### Design decision: the queue lives in `execute_campaign`, not the monitor

When no zone has capacity the campaign is parked as `AWAITING_CAPACITY` and `spot_monitor`
re-invokes `execute_campaign` (async, `InvocationType: "Event"`) once a minute until capacity
appears or `capacityWaitUntil` passes.

The monitor deliberately does **not** retry anything itself. `execute_campaign` owns the launch
path, the reservation and the deadline; duplicating any of that would give two functions a say
in when money starts being spent. The monitor only pokes it.

Three concurrency hazards this created, and how they're handled:

- **Two overlapping retries could each reserve capacity.** The monitor fires every 60s and
  `execute_campaign`'s timeout is 60s. Retries take an atomic DynamoDB claim
  (`ACQUIRING_CAPACITY` + `capacityClaimedAt`) that doubles as the status check. It is a
  5-minute **lease**, not a flag, so an invocation killed mid-flight releases the campaign;
  handled errors release it explicitly rather than waiting the lease out.
- **A crash between reserving and recording could stack reservations.** `acquireCapacityReservation()`
  first adopts any active reservation already tagged with the campaign, making it idempotent.
- **A cancel during an in-flight retry could resurrect the campaign.** The park write is
  conditional on the campaign still being startable, so a retry that lost the race cannot put a
  cancelled campaign back in the queue.

### Design decision: the hash file URL is re-signed before a queued launch

`hashFileUrl` is presigned **in the browser** for 3600s (`npkMainCtrl.js`, `Expires: 3600`) and
supplied by the client — `create_campaign` only validates it. Any campaign that waits more than
an hour would otherwise launch nodes that cannot download their hashes.

The object is in NPK's own bucket under a known key (`manifest.hashFile` is preserved), so the
retry path re-signs server-side and rewrites `manifest.json` before any node boots. **Only** on
the retry path — both immediate-launch paths are untouched, which keeps spot byte-for-byte
identical and avoids relying on Lambda credentials outliving a long presign.

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
| `terraform.jsonnet` | IAM for `CreateFleet` / `DeleteFleets` / `Describe*Fleet*` / launch templates / `TerminateInstances` / `pricing:GetProducts`; threads `onDemandPrices` into the site config. Then: capacity-reservation IAM on all three lambdas, `s3:PutObject` for the manifest rewrite, `lambda:InvokeFunction` + `execute_campaign_function` env var on `spot_monitor` |
| `jsonnet/ec2_iam_roles.libsonnet` | node role gains `ec2:DescribeFleetInstances` |
| `jsonnet/vpc.libsonnet` | subnets set `map_public_ip_on_launch` (see caveat below) |
| `templates/npk_config.tpl` | new `ONDEMANDPRICES` constant |
| `templates/userdata.tpl` | dual-model fleet enumeration; strips colon-bearing tag keys. Then: `{{INSTANCECOUNT}}` target, wait-for-full-fleet poll loop, `abort_node()` |

**Lambdas**

| File | Change |
|---|---|
| `create_campaign` | validates `provisioningModel`; selects the quota code per model; persists the model |
| `execute_campaign` | branches to launch template + `createFleet`; resolves the On-Demand rate from the Pricing API; bounds fleet life by cost *and* duration; rejects budgets too small to buy a minute. Then: capacity reservation + queue, internal `capacity-retry` invocation path, claim lease, manifest URL re-signing, budget/subnet checks moved ahead of resource creation |
| `spot_monitor` | split into independent `processSpotFleets()` / `processOnDemandFleets()` passes joined by `Promise.allSettled`; On-Demand costing is rate × uptime. Then: third `processPendingCampaigns()` pass, under-capacity reaping, reservation release, monotonic cost clamping |
| `delete_campaign` | branches to `deleteFleets`; deletes the launch template; "mark cancelled" extracted to one helper used on every exit path. Then: handles the two capacity states, releases the reservation |

**Front end**

| File | Change |
|---|---|
| `pricingSvc.js` | `getFamilyPricing(family, model)` dispatcher; `getFamilyOnDemandPrices()`; `quotaCodeFor()` |
| `npkMainCtrl.js` | `provisioningModel` + `setProvisioningModel()`; model-aware `getInstanceOptions()`; `provisioningModel` on the submitted order; quota-page model helpers. Then: `statusLabel()` on the parent scope |
| `new-campaign.html` | Spot/On-Demand toggle; price breakdown showing how the estimate is built; empty state when quota is zero |
| `quota.html` | per-model quota toggle |
| `dashboard.html`, `campaign-management.html` | spot-specific copy made conditional; status rendered through `statusLabel()` |

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
  `ValidUntil` expired, potentially hours. Now generalised (see below) to *any* fleet short of
  its target. The grace period matters: a fleet legitimately holds zero instances for the
  first seconds after creation, so reaping immediately — as first suggested — would kill
  healthy campaigns.
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

### Fixes from the 2026-08-12 incident

- **Under-capacity fleets are reaped, not just empty ones.** The check now compares
  `instanceCount` against `TargetCapacitySpecification.TotalTargetCapacity` and marks the
  campaign `INSUFFICIENT_CAPACITY` — deliberately distinct from `COMPLETED`, because a campaign
  that died for want of capacity looking like one that finished its work is the same class of
  silent failure as the split itself. It runs **before** the other reap branches and
  `continue`s, so no fleet can receive two concurrent `deleteFleets` calls.
- **The check is bounded to a 45-minute window** (`CAPACITY_CHECK_WINDOW_MS`). Terminated
  instances leave `DescribeInstances` after ~1 hour, so past that point a healthy fleet that
  lost a node would start to look under-capacity and get killed. Do not remove this bound.
- **Cost is monotonic.** See "Cost tracking is recomputed, not accumulated" above.
- **Nodes wait for the full fleet.** See the keyspace splitting section above.
- **Capacity is reserved up front**, which removes the root cause rather than detecting it.

Also fixed while in the area: the `Edit` tooling silently rewrote several files to CRLF.
`.gitattributes` pins `*.sh` and `*.tpl` to `eol=lf` precisely because a CRLF in userdata fails
on the nodes with a bare `$'\r': command not found`. **Check line endings after editing**
(`git diff --stat` warns; `python -c "print(open(f,'rb').read().count(b'\r'))"` confirms).

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

The 2026-08-12 run proved the basics: `createFleet` works, the `aws:ec2:fleet-id` tag key is
right, and the node-side `describe-fleet-instances` enumeration returns what's expected. What
has **never** run is everything added since — the reservation, the queue, and the retry path.

Three API behaviours the design rests on and that are still assumed, not observed:

- **`CreateCapacityReservation` is all-or-nothing on `InstanceCount`**, failing with
  `InsufficientInstanceCapacity` rather than partially fulfilling. The entire design depends on
  this. Both that code and `InsufficientCapacity` are treated as "no room"; anything else is
  rethrown. If it can return fewer instances than asked, the all-or-nothing property is gone
  and the keyspace guarantee goes with it.
- **The minimum `EndDate`** (assumed ≥1 hour; `acquireCapacityReservation()` clamps to it).
- **A launch template's `CapacityReservationTarget` actually routes EC2 Fleet instances into
  the reservation** rather than launching alongside it. Confirm on the first run that you are
  billed **once**, not twice.

Suggested first run, in a test account:

1. `npm run update`, confirm `npk_config.js` contains a populated `ONDEMANDPRICES`.
2. Smallest available instance (`g4dn.xlarge`), **`instanceCount: 2`**, short duration.
   Two instances is the minimum that proves keyspace splitting; one instance will pass even
   if the enumeration is broken.
3. On the nodes, check `/root/envvars` for `INSTANCECOUNT=2` and distinct `INSTANCENUMBER`
   values. This is the single most important thing to verify.
4. Confirm the campaign costs correctly in the dashboard and that the price rises at roughly
   `rate × count` per hour. **Then check it again an hour after the campaign ends** — that is
   when the old `$0.00` bug appeared, and the clamp is what should now prevent it.
5. Let one campaign hit its cost ceiling and confirm the monitor deletes the fleet.
6. Cancel another mid-run from the UI and confirm the fleet, the launch template **and the
   capacity reservation** are all gone. Check the reservation explicitly — it is the only one
   of the three that costs money while orphaned.
7. Confirm a **spot** campaign still works end to end — the monitor was restructured twice.
8. Cancel a campaign from the UI and watch the *next* monitor pass. It must stay `CANCELLED` /
   inactive — the race the `active: !isDeleted` fix addresses, visible only in the window
   where instances are still terminating.

Then the queue, which is entirely new:

9. Request a count no AZ can satisfy (or a scarce type like `g6e.xlarge` in a busy region) and
   confirm the campaign parks as `AWAITING_CAPACITY` rather than launching anything. **Confirm
   no reservation and no instances exist while it waits** — waiting must cost nothing.
10. Leave it parked for >1 hour, then let it launch. This is the presigned-URL expiry case: the
    nodes must still fetch their hashes. Check `manifest.json` in S3 was rewritten.
11. Cancel a campaign **while it is parked**, and confirm retries stop and it does not
    reappear in the queue.
12. Cancel one during the `ACQUIRING_CAPACITY` window (needs timing, or a breakpoint) to
    exercise the conditional park write.
13. Confirm the wait deadline fires: park a campaign and shorten `CAPACITY_WAIT_MAX_MS`, then
    watch it land on `INSUFFICIENT_CAPACITY` and stop being retried.
14. Check CloudWatch for `execute_campaign` **not** being invoked twice concurrently for one
    campaign — the claim lease should show one winner and `ConditionalCheckFailedException`
    losers in the logs.

### 2. Known gaps, roughly by value

- **Capacity-reservation orphans — the one that costs money.** Release is wired into every
  known exit path, and `EndDateType: "limited"` bounds the worst case. But a reservation
  created by an invocation that died before recording it, for a campaign that then never
  launches, is only cleaned up by adoption on the next retry — and if the campaign is
  cancelled first, nothing adopts it. It self-expires at `EndDate`, so the loss is bounded by
  campaign duration + 15 minutes, not unbounded. **A periodic sweeper for `active`
  reservations tagged `CampaignId` whose campaign is no longer running would close this**, and
  is the highest-value remaining gap.
- **Launch-template orphans.** Templates are deleted when the monitor sees a fleet reach a
  terminal state and when `delete_campaign` runs. A fleet that ages past the monitor's 24h
  window without reaching a terminal state leaves its template behind. Harmless and free,
  but the per-region cap is 5000. A sweeper for templates tagged `CampaignId` older than N
  days would close this — and could share an implementation with the reservation sweeper.
- **The wait deadline is a hardcoded constant.** `CAPACITY_WAIT_MAX_MS` (6h) in
  `execute_campaign`. Per-campaign control would be better — a quarterly exercise might want
  to queue overnight — but that needs a manifest field, `create_campaign` validation and UI.
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
- **`monitor_instance_action.sh` is written empty.** `userdata.tpl` uses
  `echo <<EOF > file`; `echo` ignores stdin, so the spot-interruption watcher has been a
  no-op file that cron runs every minute. Needs `cat <<EOF`. The body also references
  `/latest/meta-data/spot/intance_action` — "intance" is a typo. Pre-existing and spot-only.

### 3. Operational note for the first quarterly run

**On-Demand GPU quota is a separate limit and defaults to zero or near-zero on many
accounts.** It is independent of whatever spot quota the account already has, and an increase
request can take days. This is the most likely thing to block a scheduled exercise regardless
of whether the code is ready. Check the Quota page in the NPK console — it now has a
Spot/On-Demand toggle — and file the increase for *Running On-Demand G and VT instances*
(`L-DB2E81BA`) or *Running On-Demand P instances* (`L-417A185B`) well ahead of time.

**Quota refusals surface as a retry loop, not an error.** `acquireCapacityReservation()`
rethrows anything that isn't a capacity shortage, so a quota problem fails the retry and the
campaign stays queued until its deadline. That is deliberate — guessing which failures are
permanent would mean cancelling campaigns that might have launched — but it means *"campaign
stuck at Waiting for capacity"* is a plausible symptom of an unrelated quota problem. Check
the `execute_campaign` logs before assuming it's genuine scarcity.

**Size the campaign from GPU-hours, not from wall-clock hope.** The 2026-08-12 run wanted 5.66
GPU-hours and was given a 2-hour window; even a perfect 4-node split only just fit. Run a short
campaign first and extrapolate from the reported `%` rate before committing to a long one.

---

## Conventions worth preserving

- Absent `provisioningModel` means spot, everywhere. Keep new read sites consistent.
- The **three** monitor passes are deliberately independent, joined by `Promise.allSettled`.
  A failure in one must never prevent another from enforcing its cost ceiling — do not merge
  them or chain them.
- Cost estimates round *up* (unknown instance stop times fall back to "now"). When in doubt,
  over-estimate cost; the failure mode is a campaign ending early rather than a runaway bill.
- **A partial fleet is worse than no fleet.** It bills at full rate for a run that cannot cover
  the keyspace. Prefer refusing to launch over launching short.
- **Never let a recompute lower a recorded value.** Cost and node state are derived from APIs
  that forget; the smaller number is always the stale one.
- **Every exit path from the On-Demand launch flow must release the capacity reservation.**
  It bills whether or not anything runs in it. Cleanup helpers only ever log, so that cleanup
  failing can't mask the error that caused the abort.
- Spot behaviour was intentionally left byte-for-byte identical wherever possible. When
  changing shared code, prefer adding a branch over modifying the spot path. The exceptions
  are deliberate and noted: the node-side fleet wait and the monotonic cost clamp are genuine
  bug fixes that apply to both models.
- Anything that both a Lambda and a node need to agree on (the fleet wait vs the monitor
  grace, the claim lease vs the function timeout) has its counterpart named in a comment at
  both ends. Keep that up — these values only work as a set.
