import { Transform, type TransformCallback } from 'node:stream';

/** Checks complete frame boundaries (RFC 8878 §§3.1.1–3.1.2), not compressed contents.
 * Node 25's streaming decoder accepts truncated frames; the native decoder still
 * handles decompression, checksums and the configured window-memory limit.
 * Only a partial header is retained, never a compressed block or whole file.
 */
export class ZstdFrameGuard extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private mode: 'magic' | 'frame' | 'block' | 'skipSize' | 'skip' = 'magic';
  private remaining = 0;
  private afterSkip: 'magic' | 'block' = 'magic';
  private checksum = false;
  private frames = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    try {
      const data: Buffer = this.pending.length ? Buffer.concat([this.pending,chunk]) : chunk;
      let offset=0;
      while (offset < data.length) {
        const left=data.length-offset;
        if (this.mode==='skip') {
          const count=Math.min(this.remaining,left); offset+=count; this.remaining-=count;
          if (!this.remaining) this.mode=this.afterSkip;
        } else if (this.mode==='magic') {
          if(left<4)break;
          const magic=data.readUInt32LE(offset);offset+=4;
          if(magic===0xfd2fb528){this.mode='frame';this.frames++;}
          else if(magic>=0x184d2a50&&magic<=0x184d2a5f)this.mode='skipSize';
          else throw new Error('Invalid Zstandard frame or trailing data');
        } else if(this.mode==='skipSize') {
          if(left<4)break;
          this.remaining=data.readUInt32LE(offset);offset+=4;this.afterSkip='magic';this.mode=this.remaining?'skip':'magic';
        } else if(this.mode==='frame') {
          const descriptor=data[offset]!;
          if(descriptor&8)throw new Error('Unsupported reserved Zstandard header bit');
          const single=Boolean(descriptor&32),flag=descriptor>>>6;
          const size=1+(single?0:1)+[0,1,2,4][descriptor&3]!+(flag===0?(single?1:0):[0,2,4,8][flag]!);
          if(left<size)break;
          this.checksum=Boolean(descriptor&4);offset+=size;this.mode='block';
        } else {
          if(left<3)break;
          const header=data.readUIntLE(offset,3);offset+=3;
          const last=Boolean(header&1),type=(header>>>1)&3,size=header>>>3;
          if(type===3||size>128*1024)throw new Error('Invalid Zstandard block');
          this.remaining=(type===1?1:size)+(last&&this.checksum?4:0);
          this.afterSkip=last?'magic':'block';this.mode=this.remaining?'skip':this.afterSkip;
        }
      }
      this.pending=Buffer.from(data.subarray(offset));
      callback(null,chunk);
    }catch(error){callback(error as Error);}
  }
  override _flush(callback: TransformCallback){callback(this.pending.length||this.mode!=='magic'||!this.frames?new Error('Truncated or empty Zstandard frame'):null);}
}
