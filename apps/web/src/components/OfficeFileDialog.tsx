import { useEffect, useState } from "react";
import type { OfficeLink, SourceFile } from "@hyper/contracts";
import { api } from "../api";
import { Dialog } from "./Dialog";

export function OfficeFileDialog({
  file,
  onClose,
}: {
  file: SourceFile;
  onClose: () => void;
}) {
  const [link, setLink] = useState<OfficeLink>();
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<OfficeLink>("/files/office-link", {
      method: "POST",
      body: JSON.stringify({
        path: file.path,
        expectedId: file.id,
        expectedEtag: file.etag,
      }),
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setLink(value);
      })
      .catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [file]);

  return (
    <Dialog title="Office 协作" onClose={onClose} error={error}>
      <div className="dialog-form">
        {link ? (
          <>
            <strong>{file.name}</strong>
            <p className="muted">
              已核对所选版本。文件在 Nextcloud
              中打开，查看、编辑和保存由当前来源权限决定。
            </p>
            <a href={link.url} target="_blank" rel="noopener noreferrer">
              在新标签页打开 Office 文件
            </a>
          </>
        ) : !error ? (
          <p role="status">正在核对文件版本和权限…</p>
        ) : null}
      </div>
    </Dialog>
  );
}
