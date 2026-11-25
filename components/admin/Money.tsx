/** NT$ amount, whole dollars: `NT$4,960`. Negative amounts (refunds, discounts) read `-NT$500`. */
export function formatMoney(amount: number): string {
  const n = Math.round(Math.abs(amount)).toLocaleString("en-US");
  return `${amount < 0 ? "-" : ""}NT$${n}`;
}

export function Money({ amount }: { amount: number }) {
  return <span className="adm-num">{formatMoney(amount)}</span>;
}
