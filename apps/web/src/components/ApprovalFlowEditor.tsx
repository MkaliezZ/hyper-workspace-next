import { useState } from "react";
import {
  ApprovalDefinition,
  type ApprovalFlow,
} from "@hyper/contracts/approvals";
import { ApprovalMemberLookup } from "./ApprovalMemberLookup";
import { Dialog } from "./Dialog";

type Field = ApprovalDefinition["fields"][number];
type Stage = ApprovalDefinition["stages"][number];
type Step = Stage["steps"][number];
type Condition = Step["when"][number];
const fieldKinds: Record<Field["kind"], string> = {
  text: "文本",
  integer: "整数",
  boolean: "是或否",
  choice: "单选",
};
const operators = {
  eq: "等于",
  neq: "不等于",
  lt: "小于",
  gte: "大于或等于",
} as const;
const key = (prefix: string) => prefix + "_" + crypto.randomUUID().slice(0, 8);
const blankField = (): Field => ({
  key: key("field"),
  label: "",
  required: true,
  kind: "text",
});
const blankStep = (): Step => ({
  key: key("step"),
  label: "",
  reviewers: [],
  requiredApprovals: 1,
  when: [],
});
const blankStage = (): Stage => ({ label: "", steps: [blankStep()] });
const firstValue = (field: Field): Condition["value"] =>
  field.kind === "integer"
    ? 0
    : field.kind === "boolean"
      ? true
      : field.kind === "choice"
        ? (field.options[0] ?? "")
        : "";

function ConditionEditor({
  fields,
  value,
  onChange,
  onRemove,
}: {
  fields: Field[];
  value: Condition;
  onChange: (value: Condition) => void;
  onRemove: () => void;
}) {
  const field = fields.find((item) => item.key === value.field);
  return (
    <div className="approval-condition">
      <label>
        条件字段
        <select
          value={value.field}
          onChange={(e) => {
            const next = fields.find((item) => item.key === e.target.value);
            if (next)
              onChange({
                field: next.key,
                operator: "eq",
                value: firstValue(next),
              });
          }}
        >
          {!field ? <option value={value.field}>请选择必填字段</option> : null}
          {fields.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label || "未命名字段"}
            </option>
          ))}
        </select>
      </label>
      <label>
        比较方式
        <select
          value={value.operator}
          onChange={(e) =>
            onChange({
              ...value,
              operator: e.target.value as Condition["operator"],
            })
          }
        >
          {(field?.kind === "integer"
            ? (["eq", "neq", "lt", "gte"] as const)
            : (["eq", "neq"] as const)
          ).map((operator) => (
            <option key={operator} value={operator}>
              {operators[operator]}
            </option>
          ))}
        </select>
      </label>
      <label>
        条件值
        {field?.kind === "boolean" || field?.kind === "choice" ? (
          <select
            value={String(value.value)}
            onChange={(e) =>
              onChange({
                ...value,
                value:
                  field.kind === "boolean"
                    ? e.target.value === "true"
                    : e.target.value,
              })
            }
          >
            {field.kind === "boolean" ? (
              <>
                <option value="true">是</option>
                <option value="false">否</option>
              </>
            ) : (
              field.options.map((option, index) => (
                <option key={index}>{option}</option>
              ))
            )}
          </select>
        ) : (
          <input
            type={field?.kind === "integer" ? "number" : "text"}
            value={String(value.value)}
            onChange={(e) =>
              onChange({
                ...value,
                value:
                  field?.kind === "integer"
                    ? Number(e.target.value)
                    : e.target.value,
              })
            }
          />
        )}
      </label>
      <button type="button" onClick={onRemove}>
        移除条件
      </button>
    </div>
  );
}

function Reviewers({
  value,
  onChange,
}: {
  value: Step["reviewers"];
  onChange: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = (id: string) => {
    const normalized = id.trim().toLowerCase();
    if (normalized && !value.includes(normalized))
      onChange([...value, normalized]);
    setDraft("");
  };
  return (
    <div className="approval-reviewers">
      <details>
        <summary>从员工目录选择审批人</summary>
        <ApprovalMemberLookup onSelect={add} />
      </details>
      <div className="approval-actions">
        <label>
          审批人 ID
          <input
            aria-label="审批人 ID"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!draft.trim() || value.length >= 12}
          onClick={() => add(draft)}
        >
          添加审批人
        </button>
      </div>
      <ul>
        {value.map((id) => (
          <li key={id}>
            <span>{id}</span>{" "}
            <button
              type="button"
              aria-label={"移除审批人 " + id}
              onClick={() => onChange(value.filter((item) => item !== id))}
            >
              移除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ApprovalFlowEditor({
  previous,
  busy,
  error,
  onClose,
  onSave,
}: {
  previous?: ApprovalFlow;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (definition: ApprovalDefinition) => Promise<void>;
}) {
  const [definition, setDefinition] = useState<ApprovalDefinition>(
    () =>
      previous?.definition ?? {
        title: "",
        fields: [blankField()],
        stages: [blankStage()],
      },
  );
  const [raw, setRaw] = useState<string | null>(null);
  const [validation, setValidation] = useState("");
  const fields = definition.fields.filter((item) => item.required);
  function setStage(index: number, stage: Stage) {
    setDefinition((current) => ({
      ...current,
      stages: current.stages.map((item, i) => (i === index ? stage : item)),
    }));
  }
  function setField(index: number, field: Field) {
    setDefinition((current) => ({
      ...current,
      fields: current.fields.map((item, i) => (i === index ? field : item)),
    }));
  }
  function read() {
    const parsed = ApprovalDefinition.safeParse(
      raw === null ? definition : JSON.parse(raw),
    );
    if (!parsed.success)
      throw new Error(parsed.error.issues[0]?.message ?? "流程定义无效。");
    return parsed.data;
  }
  function toggleMode() {
    setValidation("");
    try {
      if (raw === null) setRaw(JSON.stringify(definition, null, 2));
      else {
        setDefinition(read());
        setRaw(null);
      }
    } catch (e) {
      setValidation(e instanceof Error ? e.message : "流程定义无效。");
    }
  }
  return (
    <Dialog
      title={previous ? "发布流程新版本" : "发布审批流程"}
      error={validation || error}
      wide
      onClose={onClose}
      dismissible={!busy}
    >
      <form
        className="approval-form"
        onSubmit={(e) => {
          e.preventDefault();
          setValidation("");
          try {
            void onSave(read());
          } catch (e) {
            setValidation(e instanceof Error ? e.message : "流程定义无效。");
          }
        }}
      >
        <button type="button" onClick={toggleMode}>
          {raw === null ? "高级 JSON" : "可视化配置"}
        </button>
        {raw !== null ? (
          <label>
            流程定义 JSON
            <textarea
              required
              rows={14}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
            />
          </label>
        ) : (
          <>
            <label>
              流程名称
              <input
                aria-label="流程名称"
                required
                value={definition.title}
                maxLength={100}
                onChange={(e) =>
                  setDefinition({ ...definition, title: e.target.value })
                }
              />
            </label>
            <fieldset>
              <legend>表单字段</legend>
              {definition.fields.map((field, i) => (
                <div className="approval-condition" key={field.key}>
                  <label>
                    字段名称
                    <input
                      aria-label={`字段 ${i + 1} 名称`}
                      required
                      value={field.label}
                      onChange={(e) =>
                        setField(i, { ...field, label: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    字段类型
                    <select
                      aria-label={`字段 ${i + 1} 类型`}
                      value={field.kind}
                      onChange={(e) => {
                        const kind = e.target.value as Field["kind"];
                        const { key, label, required } = field;
                        setField(
                          i,
                          kind === "choice"
                            ? { key, label, required, kind, options: ["", ""] }
                            : { key, label, required, kind },
                        );
                      }}
                    >
                      {Object.entries(fieldKinds).map(([kind, label]) => (
                        <option value={kind} key={kind}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>
                      <input
                        type="checkbox"
                        checked={field.required}
                        onChange={(e) =>
                          setField(i, { ...field, required: e.target.checked })
                        }
                      />{" "}
                      必填
                    </span>
                  </label>
                  {field.kind === "choice" ? (
                    <label>
                      选项（每行一项）
                      <textarea
                        value={field.options.join("\n")}
                        onChange={(e) =>
                          setField(i, {
                            ...field,
                            options: e.target.value.split("\n"),
                          })
                        }
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    disabled={definition.fields.length === 1}
                    onClick={() =>
                      setDefinition({
                        ...definition,
                        fields: definition.fields.filter((_, n) => n !== i),
                      })
                    }
                  >
                    移除字段
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={definition.fields.length >= 24}
                onClick={() =>
                  setDefinition({
                    ...definition,
                    fields: [...definition.fields, blankField()],
                  })
                }
              >
                添加字段
              </button>
            </fieldset>
            {definition.stages.map((stage, index) => (
              <fieldset key={index}>
                <legend>第 {index + 1} 阶段</legend>
                <label>
                  阶段名称
                  <input
                    aria-label={`阶段 ${index + 1} 名称`}
                    required
                    value={stage.label}
                    onChange={(e) =>
                      setStage(index, { ...stage, label: e.target.value })
                    }
                  />
                </label>
                {stage.steps.map((step, stepIndex) => {
                  const update = (next: Step) =>
                    setStage(index, {
                      ...stage,
                      steps: stage.steps.map((item, i) =>
                        i === stepIndex ? next : item,
                      ),
                    });
                  return (
                    <fieldset key={step.key} className="approval-editor-step">
                      <legend>步骤 {stepIndex + 1}</legend>
                      <label>
                        步骤名称
                        <input
                          aria-label={`阶段 ${index + 1} 步骤 ${stepIndex + 1} 名称`}
                          required
                          value={step.label}
                          onChange={(e) =>
                            update({ ...step, label: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        所需同意人数
                        <input
                          type="number"
                          min={1}
                          max={12}
                          required
                          value={step.requiredApprovals}
                          onChange={(e) =>
                            update({
                              ...step,
                              requiredApprovals: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <Reviewers
                        value={step.reviewers}
                        onChange={(reviewers) => update({ ...step, reviewers })}
                      />
                      {step.when.map((test, i) => (
                        <ConditionEditor
                          key={i}
                          fields={fields}
                          value={test}
                          onChange={(value) =>
                            update({
                              ...step,
                              when: step.when.map((item, n) =>
                                n === i ? value : item,
                              ),
                            })
                          }
                          onRemove={() =>
                            update({
                              ...step,
                              when: step.when.filter((_, n) => n !== i),
                            })
                          }
                        />
                      ))}
                      <div className="approval-actions">
                        <button
                          type="button"
                          disabled={!fields.length || step.when.length >= 8}
                          onClick={() => {
                            const field = fields[0]!;
                            update({
                              ...step,
                              when: [
                                ...step.when,
                                {
                                  field: field.key,
                                  operator: "eq",
                                  value: firstValue(field),
                                },
                              ],
                            });
                          }}
                        >
                          添加条件
                        </button>
                        <button
                          type="button"
                          disabled={stage.steps.length === 1}
                          onClick={() =>
                            setStage(index, {
                              ...stage,
                              steps: stage.steps.filter(
                                (_, i) => i !== stepIndex,
                              ),
                            })
                          }
                        >
                          移除步骤
                        </button>
                      </div>
                    </fieldset>
                  );
                })}
                <div className="approval-actions">
                  <button
                    type="button"
                    disabled={stage.steps.length >= 6}
                    onClick={() =>
                      setStage(index, {
                        ...stage,
                        steps: [...stage.steps, blankStep()],
                      })
                    }
                  >
                    添加并行步骤
                  </button>
                  <button
                    type="button"
                    disabled={definition.stages.length === 1}
                    onClick={() =>
                      setDefinition({
                        ...definition,
                        stages: definition.stages.filter((_, i) => i !== index),
                      })
                    }
                  >
                    移除阶段
                  </button>
                </div>
              </fieldset>
            ))}
            <button
              type="button"
              disabled={definition.stages.length >= 8}
              onClick={() =>
                setDefinition({
                  ...definition,
                  stages: [...definition.stages, blankStage()],
                })
              }
            >
              添加串行阶段
            </button>
          </>
        )}
        <button type="submit" className="primary" disabled={busy}>
          确认发布流程版本
        </button>
      </form>
    </Dialog>
  );
}
