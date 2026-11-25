import { ContentPage, contentPageMetadata } from "@/components/site/ContentPage";
import { InquiryForm } from "@/components/site/InquiryForm";
import { CONTACT } from "@/components/layout/Footer";
import type { Locale } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  return contentPageMetadata(locale, "groups", "/groups", "groupsDescription");
}

export default async function GroupsPage({ params }: Props) {
  const { locale } = await params;
  return (
    <ContentPage locale={locale} slug="groups">
      <InquiryForm hotelEmail={CONTACT.email} />
    </ContentPage>
  );
}
