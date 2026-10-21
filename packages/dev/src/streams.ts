/**
 * Line-oriented forwarding of child stdout/stderr with an attempt prefix.
 * Streaming UTF-8 decoding, bounded line buffers and explicit truncation.
 */
import { StringDecoder } from 'node:string_decoder';

export interface LinePrefixerOptions {
  readonly prefix: string;
  readonly write: (line: string) => boolean | void;
  /** Longest line kept intact; longer lines are cut with an explicit marker. */
  readonly maxLineBytes?: number;
  /** Lines dropped while the sink reports back-pressure are counted, not hidden. */
  readonly isSaturated?: () => boolean;
}

export class LinePrefixer {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private pendingBytes = 0;
  private truncatedBytes = 0;
  private dropped = 0;
  private readonly maxLineBytes: number;

  constructor(private readonly options: LinePrefixerOptions) {
    this.maxLineBytes = options.maxLineBytes ?? 64 * 1024;
  }

  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);

    this.consume(text);
  }

  /** Flush the final unterminated line when the stream ends. */
  end(): void {
    const rest = this.decoder.end();

    if (rest) this.consume(rest);

    if (this.pending.length || this.truncatedBytes) this.emit(this.pending);

    this.pending = '';
    this.pendingBytes = 0;
    this.truncatedBytes = 0;
  }

  get droppedLines(): number {
    return this.dropped;
  }

  private consume(text: string): void {
    let start = 0;

    for (;;) {
      const newline = text.indexOf('\n', start);

      if (newline === -1) {
        this.append(text.slice(start));

        return;
      }

      this.append(text.slice(start, newline));
      this.emit(this.pending);
      this.pending = '';
      this.pendingBytes = 0;
      this.truncatedBytes = 0;
      start = newline + 1;
    }
  }

  private append(part: string): void {
    const bytes = Buffer.byteLength(part);

    if (this.pendingBytes + bytes <= this.maxLineBytes) {
      this.pending += part;
      this.pendingBytes += bytes;

      return;
    }

    const room = Math.max(0, this.maxLineBytes - this.pendingBytes);

    if (room > 0) {
      this.pending += part.slice(0, room);
      this.pendingBytes += room;
    }

    this.truncatedBytes += bytes - room;
  }

  private emit(line: string): void {
    const text = this.truncatedBytes
      ? `${line.replace(/\r$/, '')} …(+${this.truncatedBytes} bytes truncated)`
      : line.replace(/\r$/, '');

    if (this.options.isSaturated?.()) {
      this.dropped += 1;

      return;
    }

    if (this.dropped) {
      const dropped = this.dropped;

      this.dropped = 0;
      this.options.write(
        `${this.options.prefix} …(${dropped} lines dropped while output was saturated)`,
      );
    }

    this.options.write(`${this.options.prefix} ${text}`);
  }
}

/** Prefix for one child stream: `[app attempt 5 stdout]`. */
export function streamPrefix(
  attempt: number,
  stream: 'stdout' | 'stderr',
): string {
  return `[app attempt ${attempt} ${stream}]`;
}
