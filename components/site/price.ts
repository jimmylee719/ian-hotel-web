/** "NT$2,980" in every locale (Intl renders TWD as "$" in zh-TW). */
export function formatPrice(amount: number): string {
  return `NT$${amount.toLocaleString("en-US")}`;
}
