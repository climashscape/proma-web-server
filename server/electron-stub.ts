/**
 * electron-stub.ts — re-export 薄壳
 *
 * 正式实现已抽为独立包 @proma/electron-stub（packages/electron-stub/src/index.ts），
 * 此文件仅为保持 server.ts 的 './electron-stub' import 不变。
 *
 * ProMA 源码侧的正式方案：源码级 patch（import 'electron' → import '@proma/electron-stub'），
 * 见 scripts/patch-proma.sh。
 */

export * from './server/packages/electron-stub/src/index'
