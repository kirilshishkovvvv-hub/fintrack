declare module 'qrcode-svg' {
  export default class QRCode {
    constructor(options: { content: string; ecl?: 'L' | 'M' | 'Q' | 'H'; join?: boolean; padding?: number; container?: string });
    svg(): string;
  }
}
