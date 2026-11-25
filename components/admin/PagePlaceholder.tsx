/** Stand-in body for admin sections a later task builds. */
export function PagePlaceholder({ title }: { title: string }) {
  return (
    <>
      <h1 className="adm-h1">{title}</h1>
      <p className="adm-muted">這個功能還在建置中。</p>
    </>
  );
}
