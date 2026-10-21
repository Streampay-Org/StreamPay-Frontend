"use client";

type FaqItem = {
  id: string;
  question: string;
  answer: string;
};

type FaqSection = {
  id: string;
  title: string;
  items: FaqItem[];
};

export type FaqSearchProps = {
  sections: FaqSection[];
  supportHref?: string;
};
