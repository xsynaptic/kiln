export interface ModelClaims {
  findings: Array<{ isTemporal?: boolean; rule: string }>;
  holds: Array<string>;
  mutants: Array<{ mutant: string; replace: string; rule: string }>;
  properties: Array<string>;
}

export const claims = {
  "bead-lifecycle": {
    findings: [],
    holds: [
      "TypeOK",
      "EveryBeadIsAccounted",
      "AResolvedParkFreesTheBead",
      "ALandedBeadIsNeverRelaunched",
      "ADeliveredPrGatesItsBead",
      "RelaunchesAreBounded",
    ],
    mutants: [
      { mutant: "ParkKeepsItInProgress", replace: "ParkedStatus", rule: "AResolvedParkFreesTheBead" },
      { mutant: "OnlyAFreshParkReopens", replace: "ReopenedStatus", rule: "EveryBeadIsAccounted" },
      { mutant: "ADeliveryLeavesNoGate", replace: "DeliveryOpensPrGate", rule: "EveryBeadIsAccounted" },
      { mutant: "TheLaunchNeverLooks", replace: "LaunchFindsItLanded", rule: "ALandedBeadIsNeverRelaunched" },
      { mutant: "TheClaimGoesFirst", replace: "ReceiptSettlesFirst", rule: "ADeliveredPrGatesItsBead" },
      { mutant: "NobodyLooksForTheDeadRunsPr", replace: "DeadRunLooksForItsPr", rule: "ALandedBeadIsNeverRelaunched" },
      { mutant: "OnlyAnOpenPrCounts", replace: "DeadRunHoldsAPr", rule: "ALandedBeadIsNeverRelaunched" },
      { mutant: "EveryProviderDeathIsFree", replace: "UnchargedDeaths", rule: "RelaunchesAreBounded" },
    ],
    properties: [],
  },
} satisfies Record<string, ModelClaims>;
