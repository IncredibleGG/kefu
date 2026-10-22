// 測試替身:@/lib/platform(模擬手機 App;記錄被開啟的網址)
export const platform = "capacitor";
export const isNative = true;
export const isMobileApp = true;
export const appVersion = "0.1.0";
export const opened = [];
export async function startExternalAuth(u) {
  opened.push(u);
}
export async function openExternal(u) {
  opened.push(u);
}
export async function nativeStorageSet() {}
