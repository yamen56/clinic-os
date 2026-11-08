-- Two automation steps for the patient's next visit: "Book an appointment"
-- (the first free time, the run then follows that appointment) and "Add to
-- the waitlist" (for when there is none).

alter table automation_steps drop constraint if exists automation_steps_step_type_check;
alter table automation_steps add constraint automation_steps_step_type_check
  check (step_type in (
    'send_whatsapp', 'send_document', 'wait', 'wait_for_reply', 'condition', 'goto_automation', 'stop',
    'add_tag', 'remove_tag', 'update_patient', 'add_note', 'update_appointment', 'book_appointment',
    'add_to_waitlist', 'assign_conversation', 'set_ai', 'flag_conversation', 'close_conversation',
    'create_task', 'notify_staff'
  ));

-- Its three ways out: booked, already booked (a visit was ahead), no free time.
alter table automation_edges drop constraint if exists automation_edges_handle_check;
alter table automation_edges add constraint automation_edges_handle_check
  check (handle ~ '^(next|yes|no|replied|timeout|other|booked|already_booked|no_slot|opt:[0-9]{1,2})$');

-- And the desk should be able to tell a booking an automation made from one a
-- person made: the patient's card says "Booked automatically", the way it
-- already says "Booked online" or "Booked by AI".
alter table appointments drop constraint if exists appointments_source_check;
alter table appointments add constraint appointments_source_check
  check (source in ('staff', 'booking_link', 'ai_agent', 'automation'));
