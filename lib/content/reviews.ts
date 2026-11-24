/**
 * Ratings and awards shown on the old site's review page (review.php). Every value is read off the
 * award images scraped from that page (content/images/review/*); nothing here is invented.
 * The old site linked to none of the listings, so neither do we.
 */
export type Award = {
  platform: string;
  /** messages key under `reviews.*` naming the award, or null for a plain rating. */
  award: "travellersChoice" | "reviewAward" | "guestRated" | "superhost" | null;
  year: number | null;
  score: number | null;
  scale: number | null;
  /** R2 key of the certificate image. */
  image: string;
};

export const AWARDS: Award[] = [
  { platform: "Hostelworld", award: null, year: null, score: 9.7, scale: 10, image: "review/review_112.jpg" },
  { platform: "Agoda", award: null, year: null, score: 9.2, scale: 10, image: "review/review_259.jpg" },
  { platform: "Hotels.com", award: null, year: 2019, score: 9.2, scale: 10, image: "review/review_111.jpg" },
  { platform: "Booking.com", award: "reviewAward", year: 2021, score: 9.1, scale: 10, image: "review/review_374.jpg" },
  { platform: "Ctrip 攜程", award: null, year: null, score: 4.7, scale: 5, image: "review/review_304.jpg" },
  { platform: "Expedia", award: "guestRated", year: 2018, score: 4.6, scale: 5, image: "review/review_260.jpg" },
  { platform: "Tripadvisor", award: "travellersChoice", year: 2019, score: null, scale: null, image: "review/review_87.jpg" },
  { platform: "Airbnb", award: "superhost", year: null, score: null, scale: null, image: "review/review_110.jpg" },
];

/** The three shown on the home page. */
export const HOME_AWARDS = AWARDS.filter((a) => ["Hostelworld", "Agoda", "Booking.com"].includes(a.platform));
