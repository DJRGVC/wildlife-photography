/// <reference types="astro/client" />

declare module 'photoswipe-dynamic-caption-plugin' {
  type CaptionPluginOptions = {
    type?: 'auto' | 'aside' | 'below';
    captionContent?:
      | string
      | ((slide: { data: { element?: HTMLElement } }) => string);
    mobileLayoutBreakpoint?: number;
    mobileCaptionOverlapRatio?: number;
    horizontalEdgeThreshold?: number;
    verticallyCenterImage?: boolean;
  };
  export default class PhotoSwipeDynamicCaption {
    constructor(lightbox: unknown, options?: CaptionPluginOptions);
  }
}
