/**
 * Tests for ICS (iCalendar) file generation utilities.
 */
// @ts-nocheck - calculateVestingDates return type requires explicit typing

import {
  escapeIcsText,
  formatIcsDate,
  generateEventUid,
  parseRate,
  calculateVestingDates,
  generateIcsFile,
  generateIcsFilename,
  foldIcsLine,
} from './ics';

/** Number of UTF-8 octets a string occupies. */
const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

describe('ICS Utilities', () => {
  describe('escapeIcsText', () => {
    it('should escape backslashes', () => {
      expect(escapeIcsText('test\\value')).toBe('test\\\\value');
    });

    it('should escape semicolons', () => {
      expect(escapeIcsText('test;value')).toBe('test\\;value');
    });

    it('should escape commas', () => {
      expect(escapeIcsText('test,value')).toBe('test\\,value');
    });

    it('should escape newlines', () => {
      expect(escapeIcsText('test\nvalue')).toBe('test\\nvalue');
    });

    it('should escape multiple special characters', () => {
      expect(escapeIcsText('test;value\\,with\nnewlines')).toBe('test\\;value\\\\\\,with\\nnewlines');
    });

    it('should handle empty strings', () => {
      expect(escapeIcsText('')).toBe('');
    });

    it('should handle strings without special characters', () => {
      expect(escapeIcsText('normal text')).toBe('normal text');
    });

    it('should escape lone carriage returns as escaped newlines', () => {
      expect(escapeIcsText('test\rvalue')).toBe('test\\nvalue');
    });

    it('should normalise CRLF line endings to a single escaped newline', () => {
      expect(escapeIcsText('test\r\nvalue')).toBe('test\\nvalue');
    });

    it('should never leave a raw carriage return in the output', () => {
      expect(escapeIcsText('a\rb\r\nc')).toBe('a\\nb\\nc');
      expect(escapeIcsText('a\rb\r\nc')).not.toContain('\r');
    });
  });

  describe('foldIcsLine', () => {
    it('should leave a line of exactly 75 octets unmodified', () => {
      const line = 'A'.repeat(75);
      expect(foldIcsLine(line)).toBe(line);
    });

    it('should fold a 76 octet line after the 75th octet', () => {
      const line = 'A'.repeat(76);
      expect(foldIcsLine(line)).toBe(`${'A'.repeat(75)}\r\n A`);
    });

    it('should not split multi-byte characters at the fold boundary', () => {
      const line = `${'A'.repeat(74)}😀B`;
      const folded = foldIcsLine(line);

      expect(folded).toBe(`${'A'.repeat(74)}\r\n 😀B`);
      expect(folded).not.toContain('\uFFFD');
    });

    it('should keep every physical line within 75 octets for wide characters', () => {
      const line = `DESCRIPTION:${'é'.repeat(200)}`;
      foldIcsLine(line)
        .split('\r\n')
        .forEach(physicalLine => {
          expect(utf8Length(physicalLine)).toBeLessThanOrEqual(75);
        });
    });

    it('should unfold back to the original logical line', () => {
      const line = `DESCRIPTION:${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4)}`;
      const folded = foldIcsLine(line);

      expect(folded).toContain('\r\n ');
      expect(folded.split('\r\n ').join('')).toBe(line);
    });

    it('should handle empty strings', () => {
      expect(foldIcsLine('')).toBe('');
    });
  });

  describe('formatIcsDate', () => {
    it('should format date to ICS datetime format', () => {
      const date = new Date('2024-01-15T10:30:00.000Z');
      expect(formatIcsDate(date)).toBe('20240115T103000Z');
    });

    it('should handle dates with milliseconds', () => {
      const date = new Date('2024-12-31T23:59:59.999Z');
      expect(formatIcsDate(date)).toBe('20241231T235959Z');
    });
  });

  describe('generateEventUid', () => {
    it('should generate unique UID with stream ID and timestamp', () => {
      const streamId = 'stream-123';
      const timestamp = new Date('2024-01-15T10:30:00.000Z');
      const uid = generateEventUid(streamId, timestamp);
      
      expect(uid).toContain(streamId);
      expect(uid).toContain('@streampay.io');
      expect(uid).toMatch(/^[a-zA-Z0-9_-]+-\d+@streampay\.io$/);
    });

    it('should generate different UIDs for different timestamps', () => {
      const streamId = 'stream-123';
      const timestamp1 = new Date('2024-01-15T10:30:00.000Z');
      const timestamp2 = new Date('2024-01-15T11:30:00.000Z');
      
      expect(generateEventUid(streamId, timestamp1)).not.toBe(generateEventUid(streamId, timestamp2));
    });
  });

  describe('parseRate', () => {
    it('should parse daily rate', () => {
      expect(parseRate('18 XLM / day')).toEqual({ amount: '18', period: 'day' });
    });

    it('should parse weekly rate', () => {
      expect(parseRate('32 XLM / week')).toEqual({ amount: '32', period: 'week' });
    });

    it('should parse monthly rate', () => {
      expect(parseRate('120 XLM / month')).toEqual({ amount: '120', period: 'month' });
    });

    it('should handle decimal amounts', () => {
      expect(parseRate('12.5 XLM / day')).toEqual({ amount: '12.5', period: 'day' });
    });

    it('should handle different spacing', () => {
      expect(parseRate('120 XLM/month')).toEqual({ amount: '120', period: 'month' });
      expect(parseRate('120XLM/month')).toEqual({ amount: '120', period: 'month' });
    });

    it('should return null for invalid format', () => {
      expect(parseRate('invalid')).toBeNull();
      expect(parseRate('XLM / day')).toBeNull();
      expect(parseRate('120 XLM')).toBeNull();
    });
  });

  describe('calculateVestingDates', () => {
    it('should calculate vesting dates for daily rate', () => {
      const events: any[] = calculateVestingDates('stream-123', '10 XLM / day', '2024-01-01T00:00:00.000Z', 'active');
      
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]).toMatchObject({
        streamId: 'stream-123',
        amount: '10',
        token: 'XLM',
      });
    });

    it('should calculate vesting dates for weekly rate', () => {
      const events = calculateVestingDates('stream-123', '50 XLM / week', '2024-01-01T00:00:00.000Z', 'active');
      
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]).toMatchObject({
        streamId: 'stream-123',
        amount: '50',
        token: 'XLM',
      });
    });

    it('should calculate vesting dates for monthly rate', () => {
      const events = calculateVestingDates('stream-123', '200 XLM / month', '2024-01-01T00:00:00.000Z', 'active');
      
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]).toMatchObject({
        streamId: 'stream-123',
        amount: '200',
        token: 'XLM',
      });
    });

    it('should skip past events', () => {
      const pastDate = new Date();
      pastDate.setFullYear(pastDate.getFullYear() - 1);
      
      const events = calculateVestingDates(
        'stream-123',
        '10 XLM / day',
        pastDate.toISOString(),
        'active',
        'XLM',
        52,
        false
      );
      
      // All events should be in the future
      events.forEach(event => {
        expect(event.start.getTime()).toBeGreaterThanOrEqual(Date.now());
      });
    });

    it('should not generate future events for ended streams', () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      
      const events = calculateVestingDates(
        'stream-123',
        '10 XLM / day',
        futureDate.toISOString(),
        'ended'
      );
      
      expect(events.length).toBe(0);
    });

    it('should not generate future events for cancelled streams', () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      
      const events = calculateVestingDates(
        'stream-123',
        '10 XLM / day',
        futureDate.toISOString(),
        'cancelled'
      );
      
      expect(events.length).toBe(0);
    });

    it('should return empty array for invalid rate format', () => {
      const events = calculateVestingDates('stream-123', 'invalid', '2024-01-01T00:00:00.000Z', 'active');
      
      expect(events.length).toBe(0);
    });

    it('should respect maxEvents parameter', () => {
      const events = calculateVestingDates(
        'stream-123',
        '10 XLM / day',
        '2024-01-01T00:00:00.000Z',
        'active',
        'XLM',
        5
      );
      
      expect(events.length).toBeLessThanOrEqual(5);
    });

    it('should use custom token', () => {
      const events = calculateVestingDates('stream-123', '10 USDC / day', '2024-01-01T00:00:00.000Z', 'active', 'USDC');
      
      expect(events[0].token).toBe('USDC');
    });
  });

  describe('generateIcsFile', () => {
    it('should generate valid ICS file structure', () => {
      const events = [
        {
          uid: 'test-uid@streampay.io',
          summary: 'Test Event',
          description: 'Test Description',
          start: new Date('2024-01-15T10:00:00.000Z'),
          end: new Date('2024-01-15T11:00:00.000Z'),
          streamId: 'stream-123',
        },
      ];
      
      const icsContent = generateIcsFile(events, 'Test Calendar');
      
      expect(icsContent).toContain('BEGIN:VCALENDAR');
      expect(icsContent).toContain('VERSION:2.0');
      expect(icsContent).toContain('PRODID:-//StreamPay//Vesting Calendar//EN');
      expect(icsContent).toContain('BEGIN:VEVENT');
      expect(icsContent).toContain('END:VEVENT');
      expect(icsContent).toContain('END:VCALENDAR');
    });

    it('should include calendar name', () => {
      const events = [];
      const icsContent = generateIcsFile(events, 'My Calendar');
      
      expect(icsContent).toContain('X-WR-CALNAME:My Calendar');
    });

    it('should escape special characters in summary and description', () => {
      const events = [
        {
          uid: 'test-uid@streampay.io',
          summary: 'Test; Event',
          description: 'Test\nDescription',
          start: new Date('2024-01-15T10:00:00.000Z'),
          end: new Date('2024-01-15T11:00:00.000Z'),
          streamId: 'stream-123',
        },
      ];
      
      const icsContent = generateIcsFile(events);
      
      expect(icsContent).toContain('SUMMARY:Test\\; Event');
      expect(icsContent).toContain('DESCRIPTION:Test\\nDescription');
    });

    it('should include location if provided', () => {
      const events = [
        {
          uid: 'test-uid@streampay.io',
          summary: 'Test Event',
          description: 'Test Description',
          start: new Date('2024-01-15T10:00:00.000Z'),
          end: new Date('2024-01-15T11:00:00.000Z'),
          location: 'Online',
          streamId: 'stream-123',
        },
      ];
      
      const icsContent = generateIcsFile(events);
      
      expect(icsContent).toContain('LOCATION:Online');
    });

    it('should handle multiple events', () => {
      const events = [
        {
          uid: 'event-1@streampay.io',
          summary: 'Event 1',
          description: 'Description 1',
          start: new Date('2024-01-15T10:00:00.000Z'),
          end: new Date('2024-01-15T11:00:00.000Z'),
          streamId: 'stream-123',
        },
        {
          uid: 'event-2@streampay.io',
          summary: 'Event 2',
          description: 'Description 2',
          start: new Date('2024-01-16T10:00:00.000Z'),
          end: new Date('2024-01-16T11:00:00.000Z'),
          streamId: 'stream-123',
        },
      ];
      
      const icsContent = generateIcsFile(events);
      
      expect(icsContent.match(/BEGIN:VEVENT/g)).toHaveLength(2);
      expect(icsContent.match(/END:VEVENT/g)).toHaveLength(2);
    });

    it('should fold long description lines and unfold to the original line', () => {
      const description = `Stream stream-123 vesting payment of 120 XLM. ${'Extra detail '.repeat(10)}`;
      const events = [
        {
          uid: 'test-uid@streampay.io',
          summary: 'Test Event',
          description,
          start: new Date('2024-01-15T10:00:00.000Z'),
          end: new Date('2024-01-15T11:00:00.000Z'),
          streamId: 'stream-123',
        },
      ];

      const icsContent = generateIcsFile(events, 'Fold Calendar');

      expect(icsContent).toContain('\r\n ');
      expect(icsContent.split('\r\n ').join('')).toContain(
        `DESCRIPTION:${escapeIcsText(description)}`
      );
    });

    it('should keep every physical line within 75 octets', () => {
      const events: any[] = calculateVestingDates(
        'stream-long',
        '120 XLM / month',
        '2024-11-01T09:00:00.000Z',
        'active',
        'XLM',
        12
      );
      events.forEach(event => {
        event.description = `${event.description} ${'A very long description. '.repeat(8)}`;
        event.summary = `${event.summary} — ${'long summary '.repeat(4)}`;
        event.location = 'StreamPay vesting calendar, online; worldwide';
      });

      const icsContent = generateIcsFile(events, 'StreamPay: A rather long calendar name for folding');

      icsContent.split('\r\n').forEach(physicalLine => {
        expect(utf8Length(physicalLine)).toBeLessThanOrEqual(75);
      });
    });

    it('should never emit a raw carriage return from event text', () => {
      const events = [
        {
          uid: 'test-uid@streampay.io',
          summary: 'Test Event',
          description: 'Line one\r\nLine two\rLine three',
          start: new Date('2024-01-15T10:00:00.000Z'),
          end: new Date('2024-01-15T11:00:00.000Z'),
          streamId: 'stream-123',
        },
      ];

      const icsContent = generateIcsFile(events);

      expect(icsContent).toContain('DESCRIPTION:Line one\\nLine two\\nLine three');
      icsContent.split('\r\n').forEach(physicalLine => {
        expect(physicalLine).not.toContain('\r');
      });
    });
  });

  describe('generateIcsFilename', () => {
    it('should generate filename with stream ID', () => {
      const filename = generateIcsFilename('stream-123');
      expect(filename).toBe('streampay-vesting-stream-123.ics');
    });

    it('should include label in filename when provided', () => {
      const filename = generateIcsFilename('stream-123', 'My Stream');
      expect(filename).toBe('streampay-vesting-My-Stream.ics');
    });

    it('should sanitize label by replacing special characters', () => {
      const filename = generateIcsFilename('stream-123', 'My Stream@#$');
      expect(filename).toBe('streampay-vesting-My-Stream---.ics');
    });

    it('should handle spaces in label', () => {
      const filename = generateIcsFilename('stream-123', 'Ada Creative Studio');
      expect(filename).toBe('streampay-vesting-Ada-Creative-Studio.ics');
    });
  });

  describe('Integration: calculateVestingDates and generateIcsFile', () => {
    it('should generate complete ICS file from stream data', () => {
      const events: any[] = calculateVestingDates(
        'stream-ada',
        '120 XLM / month',
        '2024-11-01T09:00:00.000Z',
        'active',
        'XLM'
      );
      
      const icsContent = generateIcsFile(events, 'StreamPay: Ada Creative Studio');
      
      expect(icsContent).toContain('BEGIN:VCALENDAR');
      expect(icsContent).toContain('BEGIN:VEVENT');
      expect(icsContent).toContain('SUMMARY:Vesting: 120 XLM');
      expect(icsContent).toContain('stream-ada');
      expect(icsContent).toContain('END:VEVENT');
      expect(icsContent).toContain('END:VCALENDAR');
    });

    it('should handle weekly stream with proper event spacing', () => {
      const events: any[] = calculateVestingDates(
        'stream-weekly',
        '50 XLM / week',
        '2024-01-01T00:00:00.000Z',
        'active',
        'XLM',
        4
      );
      
      expect(events.length).toBe(4);
      
      // Check that events are approximately 7 days apart
      const dayInMs = 24 * 60 * 60 * 1000;
      for (let i = 1; i < events.length; i++) {
        const diff = events[i].start.getTime() - events[i - 1].start.getTime();
        expect(Math.abs(diff - 7 * dayInMs)).toBeLessThan(1000); // Allow 1 second tolerance
      }
    });
  });
});
