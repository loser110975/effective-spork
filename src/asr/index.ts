import { AsrProvider, AsrProviderKind, AsrHooks, DouyinSyncSettings } from "../types";
import { DashscopeParaformer, DashscopeQwen3Asr } from "./dashscope";
import { SiliconflowSenseVoice } from "./siliconflow";
import { VolcengineAsr } from "./volcengine";
import { TencentAsr } from "./tencent";
import type { DouyinClient } from "../douyinClient";

export function createAsrProvider(s: DouyinSyncSettings, client?: DouyinClient | null, hooks?: AsrHooks): AsrProvider | null {
  // 统一接入：各服务商的 Base URL 与密钥均取自 settings（aiConfig.ts 负责校验语义），
  // provider 内部在 transcribe() 时对缺失 / 无效配置给出明确错误。
  switch (s.asrProvider) {
    case "siliconflow_sensevoice":
      // SenseVoice 需要本地音频文件：由调用方注入 resolveAudio（ffmpeg 抽取，带缓存）
      return new SiliconflowSenseVoice(s.siliconflowKey, hooks?.resolveAudio, s.siliconflowBaseUrl);
    case "dashscope_paraformer":
      return new DashscopeParaformer(s.dashscopeKey, s.dashscopeModel || "paraformer-v2", 30 * 60 * 1000, client, s.dashscopeBaseUrl);
    case "dashscope_qwen3":
      return new DashscopeQwen3Asr(s.dashscopeKey, s.dashscopeBaseUrl);
    case "volcengine":
      return new VolcengineAsr(s.volcAppId, s.volcToken, s.volcCluster || "volcengine_auc_common", 30 * 60 * 1000, s.volcBaseUrl);
    case "tencent":
      return new TencentAsr(s.tencentSecretId, s.tencentSecretKey, 30 * 60 * 1000, s.tencentBaseUrl);
    default:
      return null;
  }
}

export const ASR_PROVIDER_LABELS: Record<AsrProviderKind, string> = {
  none: "不转写",
  siliconflow_sensevoice: "硅基流动 SenseVoice（需本机 ffmpeg 抽音频）",
  dashscope_paraformer: "百炼 Paraformer（录音文件识别·URL直传）",
  dashscope_qwen3: "百炼 qwen3-asr-flash（多模态直转）",
  volcengine: "火山引擎 录音文件识别大模型",
  tencent: "腾讯云 录音文件识别",
};
