import { useEffect, useRef, useState } from "react";
import type { OfficeLink, OfficeVersion, SourceFile } from "@hyper/contracts";
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
  const [version, setVersion] = useState<OfficeVersion>();
  const [checking, setChecking] = useState(false);
  const versionRequest = useRef<AbortController>(null);

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
    return () => {
      controller.abort();
      versionRequest.current?.abort();
    };
  }, [file]);

  async function checkVersion() {
    if (!link || versionRequest.current) return;
    const controller = new AbortController();
    versionRequest.current = controller;
    setChecking(true);
    setError("");
    setVersion(undefined);
    try {
      const current = await api<OfficeVersion>("/files/office-version", {
        method: "POST",
        body: JSON.stringify({
          path: file.path,
          expectedId: file.id,
          expectedEtag: link.checkedEtag,
        }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setVersion(current);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setLink(undefined);
        setError(failure instanceof Error ? failure.message : "来源核对失败。");
      }
    } finally {
      versionRequest.current = null;
      if (!controller.signal.aborted) setChecking(false);
    }
  }

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
            {!checking && !version?.changed ? (
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                在新标签页打开 Office 文件
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => void checkVersion()}
              disabled={checking}
            >
              核对来源版本
            </button>
            {version ? (
              <p role="status">
                {version.changed
                  ? "来源已有新版本。请刷新文件夹后重新打开。"
                  : "来源仍是打开前核对的版本。"}
              </p>
            ) : null}
          </>
        ) : !error ? (
          <p role="status">正在核对文件版本和权限…</p>
        ) : null}
      </div>
    </Dialog>
  );
}
