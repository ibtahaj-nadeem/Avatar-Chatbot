const AZURE_TO_OCULUS: Record<number, string> = {
  0: "sil",
  1: "aa",
  2: "aa",
  3: "O",
  4: "E",
  5: "RR",
  6: "I",
  7: "U",
  8: "O",
  9: "aa",
  10: "O",
  11: "aa",
  12: "sil",
  13: "RR",
  14: "nn",
  15: "SS",
  16: "CH",
  17: "TH",
  18: "FF",
  19: "DD",
  20: "kk",
  21: "PP",
};

export function toOculusViseme(visemeId: number): string {
  return AZURE_TO_OCULUS[visemeId] ?? "sil";
}
