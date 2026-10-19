-- Material costs, taken out again.
--
-- Yamen, 2026-10-19: "i want to delete the material costs it only make things
-- more complicated". 0081 put a materials cost on each price, on a patient's
-- treatment, and frozen on each doctor's invoice line. All three go. Lab costs
-- stay (0082): they keep coming into a doctor's share by the doctor's deal
-- (clinic_members.costs_rule, which stays).
--
-- A line billed in the two days materials existed loses the materials frozen
-- on it, and its doctor's share is what it would have been without them —
-- which is what taking them out means.
--
-- Applied after the code that stops reading these columns is live.

alter table services drop column if exists material_cost;
alter table chart_marks drop column if exists material_cost;
alter table invoice_line_doctors drop column if exists material_cost;
