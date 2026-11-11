export class ProviderError extends Error {
  status: number | string;
  constructor(status: number | string, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(apiKey: string, providerModel: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(apiKey: string, providerModel: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(apiKey: string, providerTaskId: string): Promise<CheckResult>;
}
