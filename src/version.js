// 版本号的唯一来源。
//
// 规矩：只改这一行 + package.json 的 version（test/test-version.mjs 会检查两边一致）。
// 页面标题、HUD 上的版本、README 里的更新说明都以这里为准，别在别处再抄一份。
export const VERSION = '0.4.0';

/** 发布/更新时看一眼要不要顺手改 README 的「更新日志」 */
export const BUILD_NOTE = '重复段/八度线/分轨同步修复';
