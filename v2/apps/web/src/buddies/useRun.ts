import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

/** Sends a buddy command; says false, and sets the error line, when it does not go through. */
export type Run = (command: Record<string, unknown>) => Promise<boolean>;

export function useRun(setError: (message: string | undefined) => void): Run {
  const { dispatch } = useRuntime();
  return async (command) => {
    setError(undefined);
    try {
      const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
      if (response?.accepted === false) {
        setError(response.error.message);
        return false;
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not go through.");
      return false;
    }
  };
}
