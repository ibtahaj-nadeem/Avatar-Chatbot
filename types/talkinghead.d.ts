declare module "@met4citizen/talkinghead" {
  export class TalkingHead {
    public constructor(node: HTMLElement, options?: Record<string, unknown>);
  }
}

declare module "@met4citizen/talkinghead/modules/lipsync-en.mjs" {
  export class LipsyncEn {
    public preProcessText(text: string): string;
    public wordsToVisemes(word: string): {
      visemes: string[];
      times: number[];
      durations: number[];
    };
  }
}
