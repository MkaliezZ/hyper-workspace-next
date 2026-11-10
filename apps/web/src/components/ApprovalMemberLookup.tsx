import { useState } from "react";
import { api } from "../api";

export function ApprovalMemberLookup({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<
    { id: string | null; name: string; uid: string }[]
  >([]);
  const [error, setError] = useState("");
  async function search() {
    setError("");
    setRows([]);
    try {
      const result = await api<{ rows: typeof rows }>(
        "/organization?" + new URLSearchParams({ query }),
      );
      setRows(result.rows.filter((item) => item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "暂时无法读取员工。");
    }
  }
  return (
    <div className="approval-member-search">
      <label>
        查找当前员工
        <input
          maxLength={100}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <button type="button" onClick={() => void search()}>
        查询员工
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <ul>
        {rows.map((person) => (
          <li key={person.id}>
            <button type="button" onClick={() => onSelect(person.id!)}>
              {person.name} · {person.uid}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
