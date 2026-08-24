const LOGIN_TYPE_KEY = "loginType";

export type LoginType =
  | "android"
  | "friendCode"
  | "password"
  | "qr"
  | "passkey";
export type OtherLoginType = Exclude<LoginType, "android">;

export function isOtherLoginType(
  value: string | null,
): value is OtherLoginType {
  return ["friendCode", "password", "qr", "passkey"].includes(value ?? "");
}

export function readOtherLoginType(): OtherLoginType {
  try {
    const cached = localStorage.getItem(LOGIN_TYPE_KEY);
    return isOtherLoginType(cached) ? cached : "friendCode";
  } catch {
    return "friendCode";
  }
}

export function readLoginType(androidLoginAvailable: boolean): LoginType {
  return androidLoginAvailable ? "android" : readOtherLoginType();
}

export function persistLoginType(loginType: LoginType) {
  if (loginType === "android") {
    return;
  }
  try {
    localStorage.setItem(LOGIN_TYPE_KEY, loginType);
  } catch {
    // localStorage may be unavailable.
  }
}
