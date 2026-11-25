"use client";

import { useState } from "react";
import { mediaUrl } from "@/lib/media";

/**
 * A photo list (R2 keys), cover first. Upload adds to the end, drag (or the arrow buttons) reorders,
 * 設為封面 moves a photo to the front, and 移除 takes it off the list only: the file stays in R2.
 * Nothing is saved until the surrounding form saves `images`.
 */
export function PhotoManager({
  images, onChange, unitTypeId, target,
}: { images: string[]; onChange: (images: string[]) => void; unitTypeId?: string; target?: "news" | "pages" }) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= images.length || from === to) return;
    const next = [...images];
    const [k] = next.splice(from, 1);
    next.splice(to, 0, k);
    onChange(next);
  };

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setUploading(files.length);
    const added: string[] = [];
    const failed: string[] = [];
    for (const file of Array.from(files)) {
      const body = new FormData();
      body.set("file", file);
      if (unitTypeId) body.set("unitTypeId", unitTypeId);
      else if (target) body.set("target", target);
      try {
        const res = await fetch("/api/admin/uploads", { method: "POST", body });
        const json = (await res.json().catch(() => null)) as { key?: string; message?: string } | null;
        if (res.ok && json?.key) added.push(json.key);
        else failed.push(`${file.name}：${json?.message ?? "上傳失敗"}`);
      } catch {
        failed.push(`${file.name}：上傳失敗，請檢查網路`);
      }
      setUploading((n) => n - 1);
    }
    if (added.length) onChange([...images, ...added]);
    if (failed.length) setError(failed.join("\n"));
  }

  return (
    <div className="adm-photos">
      <ol className="adm-photo-list">
        {images.map((key, i) => (
          <li key={key} draggable
            className={dragFrom === i ? "adm-photo adm-photo-dragging" : "adm-photo"}
            onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={() => setDragFrom(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, i); setDragFrom(null); }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- admin thumbnails straight from the media route */}
            <img src={mediaUrl(key, 480)} alt="" loading="lazy" />
            {i === 0 ? <span className="adm-badge adm-badge-green adm-photo-cover">封面</span> : null}
            <div className="adm-photo-actions">
              <button type="button" className="adm-btn" aria-label={`第 ${i + 1} 張往前`} disabled={i === 0} onClick={() => move(i, i - 1)}>←</button>
              <button type="button" className="adm-btn" aria-label={`第 ${i + 1} 張往後`} disabled={i === images.length - 1} onClick={() => move(i, i + 1)}>→</button>
              {i > 0 ? <button type="button" className="adm-btn" onClick={() => move(i, 0)}>設為封面</button> : null}
              <button type="button" className="adm-btn adm-btn-danger-ghost" aria-label={`移除第 ${i + 1} 張`}
                onClick={() => onChange(images.filter((k) => k !== key))}>移除</button>
            </div>
          </li>
        ))}
      </ol>
      {images.length === 0 ? <p className="adm-muted">還沒有照片。公開頁面會先顯示舊網站的照片。</p> : null}
      <label className="adm-btn adm-photo-upload">
        {uploading ? `上傳中（剩 ${uploading} 張）…` : "上傳照片"}
        <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple className="adm-sr" disabled={uploading > 0}
          onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
      </label>
      <p className="adm-muted">JPEG、PNG、WebP 或 AVIF，每張最大 8 MB。拖曳可調整順序，第一張是封面。移除只會從清單拿掉，存檔後才生效。</p>
      {error ? <p className="adm-form-error adm-pre" role="alert">{error}</p> : null}
    </div>
  );
}
