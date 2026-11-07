---- MODULE spec ----
\* One bead through dispatch or an attended session, its run, reconcile, the gate pass, the gatekeeper and a human
\* Models src/queue/bd-client.ts
\* Models src/dispatch/bead-launch.ts
\* Models src/dispatch/reconcile.ts
\* Models src/queue/gates.ts
\* Models src/dispatch/gate-pass.ts
\* Models src/dispatch/dispatch.ts
\* Models src/dispatch/run-attempts.ts
\* Models src/gatekeeper/pr-views.ts
\* Models modes/detached.md
\* Models modes/attended.md
\* Sync commit none; confirmed against the uncommitted tree of 2026-11-07
EXTENDS Naturals

\* Bounds the search; a bead past this many launches stops being dispatched
MaxLaunches == 4
\* maxRunAttempts in reconcile.ts
MaxAttempts == 2
\* maxUnchargedProviderDeaths in run-attempts.ts, which is 5; reduced so the search stays small
MaxFree == 1

VARIABLES status, holder, prGate, parks, pr, needsHuman, run, launches, sessionPr, free, aborts, sinceHuman
vars == <<status, holder, prGate, parks, pr, needsHuman, run, launches, sessionPr, free, aborts, sinceHuman>>

\* holder: the bead's assignee; parks: how many open human gates block it
\* pr: the PR the latest delivering run opened; "unmerged" is closed without merging
\* run: the slot's run for this bead, "idle" once reconcile has read it or it never started
\* "session" is an attended session, which claims, gates and releases the bead itself; sessionPr: it opened a PR
\* free: the bead's provider deaths (failed:api_error, no commits); aborts: its signalled: stops; sinceHuman: launches since a human last acted on it
Outcomes == {"delivered", "diedWithPr", "committed", "nothing", "noReceipt", "apiError", "aborted"}

\* An abort is a human's, so no run ends that way on its own
RunOutcomes == Outcomes \ {"aborted"}

TypeOK ==
    /\ status \in {"open", "in_progress", "closed"}
    /\ holder \in {"none", "slot"}
    /\ prGate \in {"none", "open", "resolved"}
    /\ parks \in 0..3
    /\ pr \in {"none", "open", "merged", "unmerged"}
    /\ needsHuman \in BOOLEAN
    /\ run \in {"idle", "running", "session"} \cup Outcomes
    /\ launches \in 0..MaxLaunches
    /\ sessionPr \in BOOLEAN
    /\ free \in 0..MaxLaunches
    /\ aborts \in 0..MaxLaunches
    /\ sinceHuman \in 0..MaxLaunches

ClaimNeedsNoGate == prGate # "open" /\ parks = 0

\* bd ready --claim: open, unassigned, and no open gate blocks it
Ready == status = "open" /\ holder = "none" /\ ClaimNeedsNoGate

\* The crank seeds parkedIds from every open human gate
IsParked == parks > 0

\* bd unclaim, which also sets the status back to open
ParkedStatus == "open"

\* gateOnDeliveredPr, and the park of a run that died holding a PR, create the gh:pr gate whenever there is a PR number
DeliveryOpensPrGate == TRUE

\* parkBehindGate's reopen, since bd ready skips an in_progress bead
ReopenedStatus == "open"

LaunchFindsItLanded == prGate = "resolved" /\ pr = "merged"

\* spentAttempts: provider deaths go uncharged up to maxUnchargedProviderDeaths
UnchargedDeaths == IF free < MaxFree THEN free ELSE MaxFree

\* settlePendingRun reads a reopened bead's receipt before releaseStaleClaim drops the claim
ReceiptSettlesFirst == TRUE

\* didHoldForItsPrs: a run that left no receipt is looked up on GitHub before it is requeued or released
DeadRunLooksForItsPr == TRUE

\* The lookup takes an open or merged PR, and skips one closed unmerged
DeadRunHoldsAPr == DeadRunLooksForItsPr /\ pr \in {"open", "merged"}



Init ==
    /\ status = "open"
    /\ holder = "none"
    /\ prGate = "none"
    /\ parks = 0
    /\ pr = "none"
    /\ needsHuman = FALSE
    /\ run = "idle"
    /\ launches = 0
    /\ sessionPr = FALSE
    /\ free = 0
    /\ aborts = 0
    /\ sinceHuman = 0

\* claimUnlandedBead: a claimed bead whose resolved gate's PR merged closes instead of launching
DispatchLaunchesARun ==
    /\ Ready
    /\ launches < MaxLaunches
    /\ IF LaunchFindsItLanded
       THEN /\ status' = "closed"
            /\ UNCHANGED <<holder, run, launches, sinceHuman>>
       ELSE /\ status' = "in_progress"
            /\ holder' = "slot"
            /\ run' = "running"
            /\ launches' = launches + 1
            /\ sinceHuman' = sinceHuman + 1
    /\ UNCHANGED <<sessionPr, free, aborts, prGate, parks, pr, needsHuman>>

\* dispatchToSlot's catch: unclaimFromSlot before the run started, and before the dispatch comment that charges it
TheLaunchFails ==
    /\ run = "running"
    /\ holder = "slot"
    /\ status = "in_progress"
    /\ status' = "open"
    /\ holder' = "none"
    /\ run' = "idle"
    /\ launches' = launches - 1
    /\ sinceHuman' = IF sinceHuman > 0 THEN sinceHuman - 1 ELSE 0
    /\ UNCHANGED <<sessionPr, free, aborts, prGate, parks, pr, needsHuman>>

\* The run ends; a delivering run, or one that died after opening its PR, leaves that PR open
TheRunEnds(outcome) ==
    /\ run = "running"
    /\ run' = outcome
    /\ IF outcome \in {"delivered", "diedWithPr"}
       THEN /\ pr' = "open"
            /\ needsHuman' = FALSE
       ELSE UNCHANGED <<pr, needsHuman>>
    /\ free' = IF outcome = "apiError" THEN free + 1 ELSE free
    /\ UNCHANGED <<sessionPr, aborts, sinceHuman, status, holder, prGate, parks, launches>>

\* A signalled: stop, uncharged; counted as a human's act by convention, since a host-side kill records the same
AHumanAbortsTheRun ==
    /\ run = "running"
    /\ run' = "aborted"
    /\ aborts' = aborts + 1
    /\ sinceHuman' = 0
    /\ UNCHANGED <<sessionPr, free, status, holder, prGate, parks, pr, needsHuman, launches>>

\* detached.md: a run that finds nothing to change parks its own bead and unclaims it
TheRunFindsNothingToChange ==
    /\ run = "running"
    /\ holder = "slot"
    /\ run' = "idle"
    /\ parks' = parks + 1
    /\ status' = ParkedStatus
    /\ holder' = "none"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, prGate, pr, needsHuman, launches>>

\* didReportRunPastCeiling: parkStalledRun keeps the claim and leaves the guest running
ReconcileParksAStalledRun ==
    /\ run \in {"running", "session"}
    /\ holder = "slot"
    /\ ~IsParked
    /\ parks' = parks + 1
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, holder, prGate, pr, needsHuman, run, launches>>

ParkBead ==
    /\ parks' = parks + 1
    /\ status' = ParkedStatus
    /\ holder' = "none"

Requeue ==
    /\ status' = "open"
    /\ holder' = "none"
    /\ UNCHANGED parks

\* settleRunOutcome over the receipt the run left; gateOnDeliveredPr writes in_progress back
ReconcileReadsTheReceipt ==
    /\ run \in Outcomes
    /\ holder = "slot"
    /\ \/ status = "in_progress"
       \/ status = "open" /\ ReceiptSettlesFirst /\ (run # "noReceipt" \/ DeadRunHoldsAPr)
    /\ run' = "idle"
    /\ LET canRetry == ~IsParked /\ launches < MaxAttempts + aborts + UnchargedDeaths IN
       CASE run = "delivered" ->
                /\ prGate' = IF DeliveryOpensPrGate THEN "open" ELSE prGate
                /\ holder' = "none"
                /\ status' = "in_progress"
                /\ UNCHANGED parks
         [] run = "diedWithPr" ->
                ParkBead /\ prGate' = IF DeliveryOpensPrGate THEN "open" ELSE prGate
         [] run = "committed" ->
                ParkBead /\ UNCHANGED prGate
         [] run = "noReceipt" /\ DeadRunHoldsAPr ->
                ParkBead /\ prGate' = "open"
         [] run \in {"nothing", "noReceipt", "apiError", "aborted"} ->
                /\ IF canRetry THEN Requeue ELSE ParkBead
                /\ UNCHANGED prGate
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, pr, needsHuman, launches>>

\* The host wrapper dies after the guest opened the PR, so the run leaves no receipt
TheHostWrapperDiesAfterThePrOpens ==
    /\ run = "running"
    /\ run' = "noReceipt"
    /\ pr' = "open"
    /\ needsHuman' = FALSE
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, holder, prGate, parks, launches>>

\* attended.md: bd update --claim from bd ready, with no dispatch launch and so no charged attempt
AnAttendedSessionClaims ==
    /\ Ready
    /\ run \notin {"running", "session"}
    /\ status' = "in_progress"
    /\ holder' = "slot"
    /\ run' = "session"
    /\ sessionPr' = FALSE
    /\ sinceHuman' = 0
    /\ UNCHANGED <<free, aborts, prGate, parks, pr, needsHuman, launches>>

TheSessionOpensItsPr ==
    /\ run = "session"
    /\ holder = "slot"
    /\ ~sessionPr
    /\ pr' = "open"
    /\ needsHuman' = FALSE
    /\ sessionPr' = TRUE
    /\ UNCHANGED <<free, aborts, sinceHuman, status, holder, prGate, parks, run, launches>>

TheSessionGatesItsPr ==
    /\ run = "session"
    /\ holder = "slot"
    /\ pr = "open"
    /\ prGate # "open"
    /\ prGate' = "open"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, holder, parks, pr, needsHuman, run, launches>>

\* bd update --assignee "", which leaves the bead in_progress behind its gate
TheSessionReleasesItsClaim ==
    /\ run = "session"
    /\ holder = "slot"
    /\ prGate = "open"
    /\ holder' = "none"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, prGate, parks, pr, needsHuman, run, launches>>

\* attended.md: a session that opened its PR gates it, and only one with nothing to deliver parks
\* Bounded to a bead not yet parked; a second human gate changes nothing a rule reads
TheSessionParksItsBead ==
    /\ run = "session"
    /\ holder = "slot"
    /\ ~sessionPr
    /\ ~IsParked
    /\ parks' = parks + 1
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, holder, prGate, pr, needsHuman, run, launches>>

TheSessionUnclaimsItsParkedBead ==
    /\ run = "session"
    /\ holder = "slot"
    /\ ~sessionPr
    /\ parks > 0
    /\ holder' = "none"
    /\ status' = "open"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, prGate, parks, pr, needsHuman, run, launches>>

\* An anchored wrapper writes a receipt when the session ends, delivered if it opened a PR whatever came of it; a detached one writes none
\* Reconcile finds runs by assignee, so a session that released its claim is never read
TheSessionEnds(isAnchored) ==
    /\ run = "session"
    /\ run' = CASE holder = "none" -> "idle"
                 [] isAnchored /\ sessionPr -> "delivered"
                 [] isAnchored -> "nothing"
                 [] OTHER -> "noReceipt"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, holder, prGate, parks, pr, needsHuman, launches>>

\* An agent or a human runs bd update --status open on a bead a slot still holds
SomeoneReopensAClaimedBead ==
    /\ holder = "slot"
    /\ status = "in_progress"
    /\ status' = "open"
    /\ sinceHuman' = 0
    /\ UNCHANGED <<sessionPr, free, aborts, holder, prGate, parks, pr, needsHuman, run, launches>>

\* releaseStaleClaim: an open bead its idle slot still holds loses the claim, and the receipt goes unread
ReconcileReleasesAStaleClaim ==
    /\ holder = "slot"
    /\ status = "open"
    /\ run \in Outcomes
    /\ ReceiptSettlesFirst => (run = "noReceipt" /\ ~DeadRunHoldsAPr)
    /\ holder' = "none"
    /\ run' = "idle"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, prGate, parks, pr, needsHuman, launches>>

\* checkGates on a merged PR: bd gate check resolves the gate, then every park resolves and the bead closes
TheGatePassClosesAMergedBead ==
    /\ prGate = "open"
    /\ pr = "merged"
    /\ prGate' = "resolved"
    /\ IF status # "closed"
       THEN /\ parks' = 0
            /\ status' = "closed"
       ELSE UNCHANGED <<sessionPr, free, aborts, sinceHuman, parks, status>>
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, holder, pr, needsHuman, run, launches>>

\* parkBehindGate: a park for a bead not already parked, and an unclaimed in_progress bead reopened either way
ParkBehindGate ==
    /\ parks' = IF status # "closed" /\ ~IsParked THEN parks + 1 ELSE parks
    /\ status' = IF status = "in_progress" /\ holder = "none" THEN ReopenedStatus ELSE status

\* checkGates on a PR closed unmerged: park behind the gate, then resolve it
TheGatePassParksAnUnmergedPr ==
    /\ prGate = "open"
    /\ pr = "unmerged"
    /\ prGate' = "resolved"
    /\ ParkBehindGate
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, holder, pr, needsHuman, run, launches>>

\* settleEscalatedGate, reached only while the gate is live, so never for a parked bead
TheGatePassParksAnEscalation ==
    /\ prGate = "open"
    /\ pr = "open"
    /\ needsHuman
    /\ ~IsParked
    /\ status # "closed"
    /\ ParkBehindGate
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, prGate, holder, pr, needsHuman, run, launches>>

\* settleStrandedBeads: in_progress, unassigned, ungated, and its resolved gate's PR merged
TheCrankClosesAStrandedLandedBead ==
    /\ status = "in_progress"
    /\ holder = "none"
    /\ prGate = "resolved"
    /\ parks = 0
    /\ pr = "merged"
    /\ status' = "closed"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, holder, prGate, parks, pr, needsHuman, run, launches>>

\* planReviews takes only live gates, so the gatekeeper never sees an ungated or parked bead's PR
TheGatekeeperMerges ==
    /\ pr = "open"
    /\ prGate = "open"
    /\ ~IsParked
    /\ ~needsHuman
    /\ pr' = "merged"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, holder, prGate, parks, needsHuman, run, launches>>

TheGatekeeperEscalates ==
    /\ pr = "open"
    /\ prGate = "open"
    /\ ~IsParked
    /\ ~needsHuman
    /\ needsHuman' = TRUE
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, holder, prGate, parks, pr, run, launches>>

AHumanMergesThePr ==
    /\ pr = "open"
    /\ pr' = "merged"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, holder, prGate, parks, needsHuman, run, launches>>

AHumanClosesThePrUnmerged ==
    /\ pr = "open"
    /\ pr' = "unmerged"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, holder, prGate, parks, needsHuman, run, launches>>

AHumanResolvesAPark ==
    /\ parks > 0
    /\ parks' = parks - 1
    /\ sinceHuman' = 0
    /\ UNCHANGED <<sessionPr, free, aborts, status, holder, prGate, pr, needsHuman, run, launches>>

\* A bare bd gate check outside the crank resolves a merged PR's gate without touching its bead
AHumanRunsGateCheck ==
    /\ prGate = "open"
    /\ pr = "merged"
    /\ prGate' = "resolved"
    /\ UNCHANGED <<sessionPr, free, aborts, sinceHuman, status, holder, parks, pr, needsHuman, run, launches>>

\* Closed, or still ready once the search bound stops dispatch
Done ==
    /\ status = "closed" \/ (Ready /\ launches = MaxLaunches)
    /\ UNCHANGED vars

Next ==
    \/ DispatchLaunchesARun
    \/ TheLaunchFails
    \/ \E outcome \in RunOutcomes : TheRunEnds(outcome)
    \/ AHumanAbortsTheRun
    \/ TheRunFindsNothingToChange
    \/ ReconcileParksAStalledRun
    \/ ReconcileReadsTheReceipt
    \/ SomeoneReopensAClaimedBead
    \/ TheHostWrapperDiesAfterThePrOpens
    \/ AnAttendedSessionClaims
    \/ TheSessionOpensItsPr
    \/ TheSessionGatesItsPr
    \/ TheSessionReleasesItsClaim
    \/ TheSessionParksItsBead
    \/ TheSessionUnclaimsItsParkedBead
    \/ \E isAnchored \in BOOLEAN : TheSessionEnds(isAnchored)
    \/ ReconcileReleasesAStaleClaim
    \/ TheGatePassClosesAMergedBead
    \/ TheGatePassParksAnUnmergedPr
    \/ TheGatePassParksAnEscalation
    \/ TheCrankClosesAStrandedLandedBead
    \/ TheGatekeeperMerges
    \/ TheGatekeeperEscalates
    \/ AHumanMergesThePr
    \/ AHumanClosesThePrUnmerged
    \/ AHumanResolvesAPark
    \/ AHumanRunsGateCheck
    \/ Done

Spec == Init /\ [][Next]_vars

\* Its PR merged and its gate resolved; the stranded sweep closes it
Landed == status = "in_progress" /\ prGate = "resolved" /\ pr = "merged"

\* A bead is always closed, ready, held by a run, behind a gate, or about to close as landed
EveryBeadIsAccounted ==
    \/ status = "closed"
    \/ Ready
    \/ holder = "slot"
    \/ prGate = "open"
    \/ parks > 0
    \/ Landed

\* An unclaimed parked bead is open, so resolving its parks returns it to bd ready, unless its PR gate still holds it or its PR landed
AResolvedParkFreesTheBead ==
    (parks > 0 /\ holder = "none" /\ status # "closed") => (status = "open" \/ prGate = "open" \/ Landed)

\* A PR a run opened holds its bead off bd ready until it merges or closes, unless reconcile has yet to read the run
ADeliveredPrGatesItsBead ==
    pr = "open" => (prGate = "open" \/ status = "closed" \/ run = "session" \/ (run \in Outcomes /\ holder = "slot"))

\* Without a human act, dispatch launches a bead at most its charged attempts plus its free provider deaths
RelaunchesAreBounded == sinceHuman <= MaxAttempts + MaxFree

\* No run ever works on a bead whose PR already landed
ALandedBeadIsNeverRelaunched == run = "running" => pr # "merged"
====
