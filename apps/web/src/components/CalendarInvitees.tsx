import { useEffect, useState } from "react";
import type {
  CalendarInvitationStatus,
  CalendarMeeting,
} from "@hyper/contracts/calendar";
import { api } from "../api";

type Employee = { uid: string; name: string };
type DirectoryPage = { rows: Employee[]; nextOffset: number | null };

export function CalendarInvitees({
  selected,
  onChange,
}: {
  selected: Employee[];
  onChange: (employees: Employee[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<DirectoryPage>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ query, offset: String(offset) });
    const timer = setTimeout(() => {
      void api<DirectoryPage>("/organization?" + params, {
        signal: controller.signal,
      })
        .then((result) => {
          if (!controller.signal.aborted) setPage(result);
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setError(e instanceof Error ? e.message : "无法读取员工目录。");
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, offset]);

  function updateSearch(value: string, next: number) {
    setPage(undefined);
    setError("");
    setOffset(next);
    setQuery(value);
  }

  return (
    <div className="calendar-invitations">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "收起员工目录" : "选择参会员工"}
      </button>
      {selected.length ? (
        <ul aria-label="已选参会员工">
          {selected.map((person) => (
            <li key={person.uid}>
              {person.name} · {person.uid}{" "}
              <button
                type="button"
                aria-label={`移除 ${person.name}（${person.uid}）`}
                onClick={() =>
                  onChange(selected.filter((item) => item.uid !== person.uid))
                }
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <section aria-label="参会员工目录">
          <label>
            搜索员工
            <input
              value={query}
              maxLength={100}
              onChange={(e) => updateSearch(e.target.value, 0)}
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          {!error && !page ? <p role="status">正在读取企业成员…</p> : null}
          {page?.rows.length ? (
            <ul>
              {page.rows.map((person) => (
                <li key={person.uid}>
                  <button
                    type="button"
                    disabled={
                      selected.length >= 12 ||
                      selected.some((item) => item.uid === person.uid)
                    }
                    onClick={() => onChange([...selected, person])}
                  >
                    {person.name} · {person.uid}
                  </button>
                </li>
              ))}
            </ul>
          ) : page ? (
            <p>没有符合条件的员工。</p>
          ) : null}
          {offset > 0 ? (
            <button
              type="button"
              onClick={() => updateSearch(query, Math.max(0, offset - 30))}
            >
              上一页
            </button>
          ) : null}
          {page?.nextOffset != null ? (
            <button
              type="button"
              onClick={() => updateSearch(query, page.nextOffset!)}
            >
              下一页
            </button>
          ) : null}
          <p className="muted">
            最多邀请 12 名当前员工。保存会议时才发送邀请。
          </p>
        </section>
      ) : null}
    </div>
  );
}

const delivery = {
  delivered: "来源报告送达",
  pending: "来源处理中",
  rejected: "来源拒绝送达",
  unreported: "来源未报告送达",
};
const response = {
  needs_action: "待回复",
  accepted: "已接受",
  tentative: "暂定",
  declined: "已拒绝",
  unreported: "未报告回复",
};
export function CalendarInvitationFacts({
  invitations,
}: {
  invitations: CalendarInvitationStatus[];
}) {
  return (
    <ul className="calendar-invitation-facts" aria-label="参会邀请状态">
      {invitations.map((entry) => (
        <li key={entry.employeeUid}>
          {entry.employeeUid} · {delivery[entry.delivery]} ·{" "}
          {response[entry.response]}
        </li>
      ))}
    </ul>
  );
}

export function CalendarMeetingFacts({
  meeting,
}: {
  meeting: CalendarMeeting;
}) {
  return (
    <div>
      <p>
        {meeting.cancelled
          ? "来源会议已取消"
          : meeting.role === "organizer"
            ? "您是会议组织者"
            : "您是参会人"}
      </p>
      {meeting.ownResponse ? (
        <p>本人回复：{response[meeting.ownResponse]}</p>
      ) : null}
      {meeting.invitations ? (
        <CalendarInvitationFacts invitations={meeting.invitations} />
      ) : null}
    </div>
  );
}
