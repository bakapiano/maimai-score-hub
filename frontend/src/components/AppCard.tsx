import { Card, type CardProps } from "@mantine/core";

type ManagedCardProp =
  | "p"
  | "padding"
  | "px"
  | "py"
  | "pt"
  | "pr"
  | "pb"
  | "pl"
  | "radius"
  | "shadow"
  | "withBorder";

export type AppCardProps = Omit<CardProps, ManagedCardProp>;

/** Standard page-level card. Outer spacing belongs here, not to its content. */
export function AppCard(props: AppCardProps) {
  return (
    <Card
      {...props}
      withBorder
      shadow="none"
      p={{ base: "md", sm: "lg" }}
    />
  );
}
