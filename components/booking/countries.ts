/** ISO 3166-1 alpha-2 codes; names come from Intl.DisplayNames in the visitor's language. */
export const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO " +
  "JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR " +
  "MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO " +
  "RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV " +
  "TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

/** Calling codes for the countries guests most often come from; others type theirs. */
export const DIAL_CODES: Record<string, string> = {
  TW: "+886", JP: "+81", KR: "+82", HK: "+852", MO: "+853", CN: "+86", SG: "+65", MY: "+60", TH: "+66",
  VN: "+84", PH: "+63", ID: "+62", IN: "+91", AU: "+61", NZ: "+64", US: "+1", CA: "+1", GB: "+44", IE: "+353",
  DE: "+49", FR: "+33", NL: "+31", BE: "+32", CH: "+41", AT: "+43", IT: "+39", ES: "+34", PT: "+351", SE: "+46",
  NO: "+47", DK: "+45", FI: "+358", PL: "+48", CZ: "+420", IL: "+972", AE: "+971", TR: "+90", RU: "+7",
  BR: "+55", MX: "+52", AR: "+54", ZA: "+27",
};

/** The country a guest browsing in this language most likely comes from (pre-selects the dial code). */
export const LOCALE_COUNTRY: Record<string, string> = { "zh-TW": "TW", ja: "JP", ko: "KR", en: "" };

export function countryOptions(locale: string): { code: string; name: string }[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    names = null;
  }
  return COUNTRY_CODES
    .map((code) => ({ code, name: names?.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}
