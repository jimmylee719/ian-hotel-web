/** A mailto link with a subject line (encoded); used by the partners page so enquiries reach the existing address. */
export function mailtoWithSubject(email: string, subject: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}
