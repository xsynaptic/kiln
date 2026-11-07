---- MODULE mutants ----
EXTENDS spec

\* A mutant never calls the def it replaces, since the override would make it call itself

\* parkBead releasing with update --assignee "", which keeps the bead in_progress
ParkKeepsItInProgress == "in_progress"

\* parkBehindGate reopening only a bead it parks itself
OnlyAFreshParkReopens == IF IsParked THEN status ELSE "open"

\* gateOnDeliveredPr with no PR number in the receipt
ADeliveryLeavesNoGate == FALSE

\* fillSlots launching whatever claimNextReady hands it
TheLaunchNeverLooks == FALSE
\* settlePendingRun releasing a reopened bead's claim before it reads the receipt
TheClaimGoesFirst == FALSE
\* settlePendingRun requeueing a run with no receipt without asking GitHub for its PR
NobodyLooksForTheDeadRunsPr == FALSE
\* The dead run's lookup taking only an open PR, so one merged before the crank reads as no PR
OnlyAnOpenPrCounts == DeadRunLooksForItsPr /\ pr = "open"
\* spentAttempts forgiving every provider death, with no cap
EveryProviderDeathIsFree == free
====
