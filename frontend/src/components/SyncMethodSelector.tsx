import type { ReactNode } from "react";

import {
  RadioCardGroup,
} from "./RadioCardGroup";
import {
  getSyncMethodOptions,
  type SyncMethod,
} from "./syncMethodOptions";

export type { SyncMethod } from "./syncMethodOptions";

export function SyncMethodSelector({
  value,
  androidAvailable,
  androidPanel,
  onChange,
}: {
  value: SyncMethod;
  androidAvailable: boolean;
  androidPanel: ReactNode;
  onChange: (value: SyncMethod) => void;
}) {
  const options = getSyncMethodOptions(androidAvailable);

  return (
    <>
      <RadioCardGroup
        value={value}
        onChange={(nextValue) => onChange(nextValue as SyncMethod)}
        data={options}
      />
      {androidAvailable && value === "android_local" ? androidPanel : null}
    </>
  );
}
