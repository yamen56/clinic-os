-- What each template is for, in Arabic as well as English. The gallery card
-- showed only a template's name, its trigger and a row of step icons — a
-- headline — so a clinic choosing one could not see what problem it solves or
-- what the patient would receive. The card shows this now, in the clinic's
-- language.
alter table recipe_templates add column if not exists description_ar text not null default '';
