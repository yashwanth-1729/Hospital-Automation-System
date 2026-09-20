-- The management summary describes a period, so one per day is not enough:
-- the 7-day and 30-day views need their own cached summary.

ALTER TABLE daily_summaries ADD COLUMN period_days integer NOT NULL DEFAULT 7;
ALTER TABLE daily_summaries DROP CONSTRAINT daily_summaries_pkey;
ALTER TABLE daily_summaries ADD PRIMARY KEY (summary_date, period_days);
