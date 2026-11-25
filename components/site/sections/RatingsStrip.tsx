/** Guest ratings as large Newsreader numerals (gold on ink, accent on paper) over the platform in small caps. */
export function RatingsStrip({ awards }: { awards: { platform: string; score: string; scale: string }[] }) {
  return (
    <ul className="ratings">
      {awards.map((a) => (
        <li key={a.platform}>
          <span className="ratings-score">
            {a.score}
            <small> / {a.scale}</small>
          </span>
          <span className="ratings-platform" lang="en">
            {a.platform}
          </span>
        </li>
      ))}
    </ul>
  );
}
