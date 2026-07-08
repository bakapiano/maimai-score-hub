import { Image, type ImageProps } from "@mantine/core";
import type { ImgHTMLAttributes } from "react";

import {
  DEFAULT_IMAGE_PLACEHOLDER,
  useDeferredVisibleSrc,
} from "../utils/deferredImage";

type DeferredImageProps = Omit<ImageProps, "src" | "fallbackSrc"> & {
  src: string;
  fallbackSrc?: string;
  alt?: string;
  referrerPolicy?: ImgHTMLAttributes<HTMLImageElement>["referrerPolicy"];
  eager?: boolean;
  rootMargin?: string;
  idleTimeout?: number;
};

export function DeferredImage({
  src,
  fallbackSrc = DEFAULT_IMAGE_PLACEHOLDER,
  eager = false,
  rootMargin,
  idleTimeout,
  ...props
}: DeferredImageProps) {
  const [imageRef, deferredSrc, isDeferred] =
    useDeferredVisibleSrc<HTMLImageElement>(src, {
      disabled: eager,
      rootMargin,
      idleTimeout,
    });

  return (
    <Image
      {...props}
      ref={imageRef}
      src={deferredSrc}
      fallbackSrc={fallbackSrc}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      data-deferred-image={isDeferred || undefined}
    />
  );
}
