"use client";

import React, { useState } from "react";

export interface DateRangePickerProps {
  startDate?: string;
  endDate?: string;
  onChange?: (range: { startDate: string; endDate: string }) => void;
  label?: string;
}

export function DateRangePicker({
  startDate = "",
  endDate = "",
  onChange,
  label = "Date range",
}: DateRangePickerProps) {
  const [start, setStart] = useState(startDate);
  const [end, setEnd] = useState(endDate);

  const handleStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setStart(val);
    onChange?.({ startDate: val, endDate: end });
  };

  const handleEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setEnd(val);
    onChange?.({ startDate: start, endDate: val });
  };

  return (
    <fieldset className="date-range-picker flex flex-col gap-2 rounded-lg border p-3">
      <legend className="text-xs font-semibold uppercase text-zinc-500">{label}</legend>
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">
          Start Date
          <input
            type="date"
            aria-label="Start date"
            value={start}
            onChange={handleStartChange}
            className="ml-2 rounded border px-2 py-1 text-sm"
          />
        </label>
        <span className="text-zinc-400">–</span>
        <label className="text-sm font-medium">
          End Date
          <input
            type="date"
            aria-label="End date"
            value={end}
            onChange={handleEndChange}
            className="ml-2 rounded border px-2 py-1 text-sm"
          />
        </label>
      </div>
    </fieldset>
  );
}

export default DateRangePicker;