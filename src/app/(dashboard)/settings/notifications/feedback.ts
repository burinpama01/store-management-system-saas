export type ActionFeedbackStatus = "idle" | "success" | "error";

export interface ActionFeedbackState {
  status: ActionFeedbackStatus;
  message: string | null;
  submittedAt: number;
}

export const INITIAL_ACTION_FEEDBACK_STATE: ActionFeedbackState = {
  status: "idle",
  message: null,
  submittedAt: 0,
};
