// 第十三轮测试（2026-10-01）：真实运行数据驱动的两项改进。
// ① isQuotaExhaustedError——配额耗尽类错误识别（09-21 实测 50 连发相同 403 的熔断判定依据，
//    真实样本取自 data.json summary records 的 errorMessage）；
// ② isFolderApiUnavailableError——收藏夹 API 下线识别（2026-10-01 桥接实测 collection/* 子树
//    全部 404 "Unsupported path(Janus)"，调用方据此把 error 降级为 notice）。
import assert from "node:assert/strict";

export function runTests(m) {
  let pass = 0,
    fail = 0;
  const t = (name, ok) => {
    if (ok) {
      pass++;
      console.log("  ✓ " + name);
    } else {
      fail++;
      console.log("  ✗ " + name);
    }
  };

  console.log("— isQuotaExhaustedError：配额熔断判定（第十三轮）—");
  {
    // 09-21 真实样本（data.json summary[0].errorMessage 原文形态）
    const real =
      "多模态总结失败：AI HTTP 403: {\"error\":{\"message\":\"Free quota exhausted. To continue accessing the model, please top up\"}}";
    t("真实 403 样本（Free quota exhausted）命中", m.isQuotaExhaustedError(real) === true);
    t("百炼 AllocationQuota.FreeTierOnly 命中", m.isQuotaExhaustedError("多模态总结失败：AI HTTP 403: AllocationQuota.FreeTierOnly") === true);
    t("小写变体命中（大小写无关）", m.isQuotaExhaustedError("free quota exhausted") === true);
    t("欠费（中文）命中", m.isQuotaExhaustedError("账户欠费，请充值后重试") === true);
    t("Arrears 命中", m.isQuotaExhaustedError("Arrears: account in debt") === true);
    t("普通 5xx 不命中", m.isQuotaExhaustedError("AI HTTP 503: System is too busy now") === false);
    t("网络异常不命中", m.isQuotaExhaustedError("AI 请求超时（300s，重试 1 次后仍超时）") === false);
    t("配额恢复成功消息不命中", m.isQuotaExhaustedError("视频摘要已生成") === false);
    t("空串安全", m.isQuotaExhaustedError("") === false);
    t("undefined/null 安全", m.isQuotaExhaustedError(undefined) === false && m.isQuotaExhaustedError(null) === false);
  }

  console.log("— isFolderApiUnavailableError：收藏夹 API 下线判定（第十三轮）—");
  {
    t("listFolders 的 404 文本命中", m.isFolderApiUnavailableError("collection/list HTTP 404") === true);
    t("listFolderItems 的 404 + Janus 文本命中", m.isFolderApiUnavailableError("collection/item/list: HTTP 404 Unsupported path(Janus)") === true);
    t("纯 Unsupported path 命中（大小写无关）", m.isFolderApiUnavailableError("unsupported path(janus)") === true);
    t("5xx 不命中（保持 error 观感）", m.isFolderApiUnavailableError("collection/list HTTP 502") === false);
    t("网络异常不命中", m.isFolderApiUnavailableError("collection/list 网络异常：net::ERR_CONNECTION_CLOSED") === false);
    t("403 风控不命中", m.isFolderApiUnavailableError("collection/list HTTP 403 Blocked by ArgusSecurityPlugin") === false);
    t("空串安全", m.isFolderApiUnavailableError("") === false);
    t("undefined/null 安全", m.isFolderApiUnavailableError(undefined) === false && m.isFolderApiUnavailableError(null) === false);
  }

  console.log(`小计：${pass} 通过，${fail} 失败`);
  if (fail > 0) throw new Error(`round13-data: ${fail} 个断言失败`);
  return { pass, fail };
}
