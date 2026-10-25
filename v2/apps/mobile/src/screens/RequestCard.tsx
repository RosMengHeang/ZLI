import { describeApproval, describeQuestions, type InputQuestion } from "@zli-v2/client-runtime";
import type { ThreadRequestProjection } from "@zli-v2/contracts";
import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useLink } from "../LinkContext.js";
import { sendCommand } from "../lib/launch.js";
import { mono, radius, space, type, usePalette } from "../theme.js";
import { Banner, Button, Card, Choice, Field } from "../ui/components.js";

/** An approval or a question from an agent, answered from the phone. */
export function RequestCard({
  request,
  provider,
  agentName,
}: {
  request: ThreadRequestProjection;
  provider: string;
  agentName: string;
}) {
  const link = useLink();
  const palette = usePalette();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const approval = request.kind === "approval";

  const send = async (key: string, command: Record<string, unknown> & { type: string }) => {
    setBusy(key);
    setError(undefined);
    const outcome = await sendCommand(link, command, "The answer did not reach the desktop. Try again.");
    // On success the request leaves the projection and this card unmounts.
    if (!outcome.ok) {
      setError(outcome.error);
      setBusy(undefined);
    }
  };

  return (
    <Card style={{ borderColor: palette.tones.amber.ink }}>
      <Text accessibilityRole="header" style={[local.title, { color: palette.text }]}>
        {approval ? `${agentName} asks to continue` : `${agentName} has a question`}
      </Text>
      {approval ? (
        <Approval
          request={request}
          provider={provider}
          busy={busy}
          onChoose={(key, decision) =>
            void send(key, {
              type: "thread.respond",
              threadId: request.threadId,
              requestId: request.requestId,
              decision,
            })
          }
        />
      ) : (
        <Questions
          request={request}
          busy={busy !== undefined}
          onSubmit={(answers) =>
            void send("answer", {
              type: "thread.user-input",
              threadId: request.threadId,
              requestId: request.requestId,
              answers,
            })
          }
        />
      )}
      {error ? <Banner tone="error" message={error} /> : null}
    </Card>
  );
}

function Approval({
  request,
  provider,
  busy,
  onChoose,
}: {
  request: ThreadRequestProjection;
  provider: string;
  busy: string | undefined;
  onChoose: (key: string, decision: unknown) => void;
}) {
  const palette = usePalette();
  const view = useMemo(() => describeApproval(provider, request.payload), [provider, request.payload]);
  return (
    <>
      <Text style={[local.body, { color: palette.text }]}>{view.title}</Text>
      {view.fields.map((field) => (
        <View key={field.label} style={local.field}>
          <Text style={[local.fieldLabel, { color: palette.muted }]}>{field.label}</Text>
          <Text
            selectable
            style={[
              field.mono ? local.code : local.body,
              { color: palette.text, backgroundColor: field.mono ? palette.well : "transparent" },
            ]}
          >
            {field.value}
          </Text>
        </View>
      ))}
      <View style={local.choices}>
        {view.choices.map((choice) => (
          <Button
            key={choice.key}
            label={choice.label}
            variant={choice.tone}
            busy={busy === choice.key}
            disabled={busy !== undefined && busy !== choice.key}
            onPress={() => onChoose(choice.key, choice.decision)}
          />
        ))}
      </View>
    </>
  );
}

function Questions({
  request,
  busy,
  onSubmit,
}: {
  request: ThreadRequestProjection;
  busy: boolean;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const questions = useMemo(() => describeQuestions(request.payload), [request.payload]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete = questions.every((question) => (answers[question.id] ?? "").trim().length > 0);
  const set = (id: string, value: string) => setAnswers((current) => ({ ...current, [id]: value }));
  return (
    <>
      {questions.map((question) => (
        <Question key={question.id} question={question} value={answers[question.id] ?? ""} onChange={set} />
      ))}
      <Button
        label={questions.length > 1 ? "Send answers" : "Send answer"}
        variant="primary"
        busy={busy}
        disabled={!complete}
        {...(complete ? {} : { accessibilityHint: "Answer every question first" })}
        onPress={() => onSubmit(answers)}
      />
    </>
  );
}

function Question({
  question,
  value,
  onChange,
}: {
  question: InputQuestion;
  value: string;
  onChange: (id: string, value: string) => void;
}) {
  const palette = usePalette();
  const picked = question.options.some((option) => option.label === value);
  return (
    <View style={local.question} accessibilityRole="radiogroup" accessibilityLabel={question.question}>
      {question.header && question.header !== question.question ? (
        <Text style={[local.fieldLabel, { color: palette.muted }]}>{question.header}</Text>
      ) : null}
      <Text style={[local.body, { color: palette.text }]}>{question.question}</Text>
      {question.options.map((option) => (
        <Choice
          key={option.label}
          label={option.label}
          description={option.description}
          checked={value === option.label}
          onPress={() => onChange(question.id, option.label)}
        />
      ))}
      {question.allowOther ? (
        <Field
          label={question.options.length > 0 ? "Or type your own answer" : "Your answer"}
          value={picked ? "" : value}
          onChangeText={(text) => onChange(question.id, text)}
          secureTextEntry={question.secret}
          autoCorrect={!question.secret}
          autoCapitalize={question.secret ? "none" : "sentences"}
        />
      ) : null}
    </View>
  );
}

const local = StyleSheet.create({
  title: { fontSize: type.title, fontWeight: "600" },
  body: { fontSize: type.body, lineHeight: 22 },
  field: { gap: 2 },
  fieldLabel: { fontSize: type.meta, fontWeight: "600" },
  code: { fontFamily: mono, fontSize: type.meta, lineHeight: 18, padding: space.sm, borderRadius: radius.sm },
  choices: { gap: space.sm },
  question: { gap: space.sm },
});
