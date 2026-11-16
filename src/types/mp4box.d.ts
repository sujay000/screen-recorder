// Minimal typings for the parts of mp4box.js this app uses.
declare module 'mp4box' {
  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }
  export interface MP4VideoTrack {
    id: number;
    codec: string;
    timescale: number;
    nb_samples: number;
    video: { width: number; height: number };
  }
  export interface MP4Info {
    videoTracks: MP4VideoTrack[];
  }
  export interface MP4Sample {
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
    is_sync: boolean;
    data: Uint8Array;
  }
  interface CodecBox {
    write(stream: DataStream): void;
  }
  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onError?: (e: string) => void;
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer(buf: MP4ArrayBuffer): number;
    flush(): void;
    start(): void;
    setExtractionOptions(id: number, user: unknown, opts: { nbSamples: number }): void;
    getTrackById(id: number): {
      mdia: { minf: { stbl: { stsd: { entries: { avcC?: CodecBox; hvcC?: CodecBox; vpcC?: CodecBox; av1C?: CodecBox }[] } } } };
    };
  }
  export class DataStream {
    static BIG_ENDIAN: boolean;
    constructor(buffer: ArrayBuffer | undefined, byteOffset: number, endianness: boolean);
    buffer: ArrayBuffer;
  }
  export function createFile(): MP4File;
}
