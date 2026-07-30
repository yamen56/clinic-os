-- Agency starter library: the consent forms and agreements a new clinic gets on
-- day one, in Arabic and English.
--
-- Copied into each clinic on creation, never referenced afterwards, so a clinic
-- owns and can rewrite every word of its own forms. Bodies are dollar-quoted
-- because they contain apostrophes and {{merge.tokens}} that must survive
-- verbatim.

insert into document_template_library (key, name, name_ar, category, sort, body, body_ar, signer_config, fields_schema)
values
------------------------------------------------------------------------ 1
(
  'general_treatment_consent',
  'General consent to treatment',
  'موافقة عامة على العلاج',
  'consent',
  10,
$en$<p>I, <strong>{{patient.full_name}}</strong>, national ID <strong>{{patient.national_id}}</strong>, date of birth {{patient.birth_date}}, reachable on {{patient.phone}}, give my consent to receive treatment at <strong>{{clinic.name}}</strong>.</p>
<h2>What I have been told</h2>
<ul>
<li>The nature of the proposed treatment, <strong>{{service.name}}</strong>, has been explained to me in language I understand.</li>
<li>I have been told the expected benefits, the common risks, and the alternatives, including the option of no treatment at all.</li>
<li>I understand that the practice of medicine and dentistry is not an exact science, and that no guarantee has been made to me about the result.</li>
<li>I have had the opportunity to ask questions, and my questions were answered.</li>
</ul>
<h2>What I agree to</h2>
<ul>
<li>I consent to the treatment described above being carried out by {{doctor.name}} or by a suitably qualified colleague at this clinic.</li>
<li>I consent to any additional procedure that becomes immediately necessary during treatment to safeguard my health.</li>
<li>I confirm that I have disclosed my full medical history, all medications I take, and any allergies.</li>
</ul>
<h2>Withdrawing consent</h2>
<p>I understand that I may withdraw this consent at any time before or during treatment, and that doing so will not affect my right to care.</p>
<hr />
<p>Signed at {{clinic.name}}, {{clinic.address}} — on {{today}}.</p>$en$,
$ar$<p>أنا، <strong>{{patient.full_name}}</strong>، الرقم الوطني <strong>{{patient.national_id}}</strong>، تاريخ الميلاد {{patient.birth_date}}، رقم الهاتف {{patient.phone}}، أوافق على تلقّي العلاج في <strong>{{clinic.name}}</strong>.</p>
<h2>ما تم إبلاغي به</h2>
<ul>
<li>شُرحت لي طبيعة العلاج المقترح، <strong>{{service.name}}</strong>، بلغة أفهمها.</li>
<li>أُبلغت بالفوائد المتوقّعة والمخاطر الشائعة والبدائل المتاحة، بما في ذلك خيار عدم العلاج.</li>
<li>أدرك أن الطب وطب الأسنان ليسا علماً دقيقاً، وأنه لم تُقدَّم لي أي ضمانة بشأن النتيجة.</li>
<li>أُتيحت لي الفرصة لطرح الأسئلة، وأُجيب عن أسئلتي.</li>
</ul>
<h2>ما أوافق عليه</h2>
<ul>
<li>أوافق على إجراء العلاج الموضّح أعلاه من قِبل {{doctor.name}} أو من قِبل زميل مؤهّل في هذه العيادة.</li>
<li>أوافق على أي إجراء إضافي يصبح ضرورياً بشكل عاجل أثناء العلاج للحفاظ على صحتي.</li>
<li>أؤكّد أنني أفصحت عن تاريخي الطبي الكامل وجميع الأدوية التي أتناولها وأي حساسية لدي.</li>
</ul>
<h2>سحب الموافقة</h2>
<p>أدرك أن لي الحق في سحب هذه الموافقة في أي وقت قبل العلاج أو أثناءه، وأن ذلك لا يؤثّر على حقي في الرعاية.</p>
<hr />
<p>وُقّع في {{clinic.name}}، {{clinic.address}} — بتاريخ {{today}}.</p>$ar$,
  '{"mode":"sequential","signers":[{"role_key":"patient","required":true,"order":0},{"role_key":"doctor","required":true,"order":1}]}',
  '[]'
),
------------------------------------------------------------------------ 2
(
  'surgical_procedure_consent',
  'Consent to a surgical procedure',
  'موافقة على إجراء جراحي',
  'consent',
  20,
$en$<p>Patient: <strong>{{patient.full_name}}</strong> · ID {{patient.national_id}} · {{patient.phone}}</p>
<p>Procedure: <strong>{{service.name}}</strong> · Scheduled for {{appointment.date}} · Performed by {{doctor.name}}</p>
<h2>The procedure</h2>
<p>The procedure named above has been explained to me, including what will be done, how long it is expected to take, and what anaesthesia or sedation will be used.</p>
<h2>Risks I accept</h2>
<ul>
<li>Pain, swelling, bruising and bleeding in the days following the procedure.</li>
<li>Infection, which may require antibiotics or further treatment.</li>
<li>Temporary or, rarely, lasting numbness or altered sensation near the site.</li>
<li>The possibility that the procedure cannot be completed as planned, and that a further appointment or a different approach becomes necessary.</li>
<li>Reaction to anaesthetic or to medication prescribed afterwards.</li>
</ul>
<h2>Aftercare</h2>
<p>I have received aftercare instructions and I understand that following them affects the outcome. I know how to contact the clinic on {{clinic.phone}} if something concerns me.</p>
<h2>Declaration</h2>
<p>I confirm that I am not aware of any condition, medication or allergy that I have not disclosed, and that I have not withheld anything relevant to my safety during this procedure.</p>
<hr />
<p>{{clinic.name}} — {{today}}</p>$en$,
$ar$<p>المريض: <strong>{{patient.full_name}}</strong> · الرقم الوطني {{patient.national_id}} · {{patient.phone}}</p>
<p>الإجراء: <strong>{{service.name}}</strong> · بتاريخ {{appointment.date}} · يُجريه {{doctor.name}}</p>
<h2>الإجراء</h2>
<p>شُرح لي الإجراء المذكور أعلاه، بما يشمل ما سيُنفَّذ والمدة المتوقّعة ونوع التخدير أو التهدئة الذي سيُستخدم.</p>
<h2>المخاطر التي أقبلها</h2>
<ul>
<li>الألم والتورّم والكدمات والنزف في الأيام التالية للإجراء.</li>
<li>الالتهاب، الذي قد يتطلّب مضادات حيوية أو علاجاً إضافياً.</li>
<li>تنميل مؤقت أو، في حالات نادرة، تغيّر دائم في الإحساس قرب موضع الإجراء.</li>
<li>احتمال عدم إمكانية إتمام الإجراء كما هو مخطّط، وحاجة الأمر إلى موعد آخر أو أسلوب مختلف.</li>
<li>رد فعل تحسّسي تجاه المخدّر أو تجاه الأدوية الموصوفة بعد الإجراء.</li>
</ul>
<h2>الرعاية بعد الإجراء</h2>
<p>تلقّيت تعليمات الرعاية بعد الإجراء وأدرك أن الالتزام بها يؤثّر على النتيجة. وأعرف كيف أتواصل مع العيادة على الرقم {{clinic.phone}} إذا قلقني أي أمر.</p>
<h2>إقرار</h2>
<p>أؤكّد أنه لا يوجد لدي أي حالة صحية أو دواء أو حساسية لم أفصح عنها، وأنني لم أُخفِ أي معلومة تتعلّق بسلامتي أثناء هذا الإجراء.</p>
<hr />
<p>{{clinic.name}} — {{today}}</p>$ar$,
  '{"mode":"sequential","signers":[{"role_key":"patient","required":true,"order":0},{"role_key":"doctor","required":true,"order":1},{"role_key":"witness","required":false,"order":2}]}',
  '[]'
),
------------------------------------------------------------------------ 3
(
  'treatment_plan_agreement',
  'Treatment plan and cost agreement',
  'خطة العلاج والاتفاقية المالية',
  'treatment_plan',
  30,
$en$<p>Between <strong>{{clinic.name}}</strong>, {{clinic.address}} — and <strong>{{patient.full_name}}</strong>, {{patient.phone}}.</p>
<h2>The plan</h2>
<p>The clinic has proposed the following course of treatment: <strong>{{service.name}}</strong>. The plan, its stages and the expected number of visits have been explained to me and I have received a copy.</p>
<h2>The cost</h2>
<ul>
<li>The agreed fee for this course of treatment is <strong>{{service.price}}</strong>.</li>
<li>This figure covers the treatment as planned. If the plan changes for clinical reasons, the clinic will tell me before any additional cost is incurred and will obtain my agreement to it.</li>
<li>Laboratory work, imaging and medication are included only where stated.</li>
</ul>
<h2>What the clinic commits to</h2>
<ul>
<li>To carry out the treatment to a professional standard, by a qualified practitioner.</li>
<li>To tell me promptly if the plan needs to change, and why.</li>
<li>To keep my records and to give me a copy of anything I sign.</li>
</ul>
<h2>What I commit to</h2>
<ul>
<li>To attend the appointments in the plan, and to give the clinic reasonable notice if I cannot.</li>
<li>To follow the aftercare instructions I am given.</li>
<li>To pay the agreed fee as set out above.</li>
</ul>
<hr />
<p>Agreed on {{today}}.</p>$en$,
$ar$<p>بين <strong>{{clinic.name}}</strong>، {{clinic.address}} — و<strong>{{patient.full_name}}</strong>، {{patient.phone}}.</p>
<h2>الخطة</h2>
<p>اقترحت العيادة خطة العلاج التالية: <strong>{{service.name}}</strong>. شُرحت لي الخطة ومراحلها وعدد الزيارات المتوقّع، وتلقّيت نسخة منها.</p>
<h2>التكلفة</h2>
<ul>
<li>الأجر المتّفق عليه لهذه الخطة هو <strong>{{service.price}}</strong>.</li>
<li>يشمل هذا المبلغ العلاج كما هو مخطّط. وإذا تغيّرت الخطة لأسباب سريرية، تُبلغني العيادة قبل تحمّل أي تكلفة إضافية وتحصل على موافقتي عليها.</li>
<li>أعمال المختبر والتصوير والأدوية مشمولة فقط حيث يُنَص على ذلك.</li>
</ul>
<h2>ما تتعهّد به العيادة</h2>
<ul>
<li>تنفيذ العلاج وفق معيار مهني، على يد ممارس مؤهّل.</li>
<li>إبلاغي فوراً إذا احتاجت الخطة إلى تغيير، وبيان السبب.</li>
<li>الاحتفاظ بسجلاتي وتزويدي بنسخة من كل ما أوقّعه.</li>
</ul>
<h2>ما أتعهّد به</h2>
<ul>
<li>الحضور في مواعيد الخطة، وإشعار العيادة بوقت معقول إن تعذّر ذلك.</li>
<li>الالتزام بتعليمات الرعاية التي أتلقّاها.</li>
<li>سداد الأجر المتّفق عليه كما هو مبيّن أعلاه.</li>
</ul>
<hr />
<p>اتُّفق عليه بتاريخ {{today}}.</p>$ar$,
  '{"mode":"sequential","signers":[{"role_key":"patient","required":true,"order":0},{"role_key":"clinic_owner","required":true,"order":1}]}',
  '[]'
),
------------------------------------------------------------------------ 4
(
  'financial_agreement',
  'Payment agreement',
  'اتفاقية الدفع',
  'financial',
  40,
$en$<p><strong>{{patient.full_name}}</strong> · {{patient.phone}} · {{clinic.name}}</p>
<h2>Amount and schedule</h2>
<p>The total amount payable for the agreed treatment is <strong>{{service.price}}</strong>. I agree to pay it on the schedule recorded below, agreed with the clinic on {{today}}.</p>
<table><tbody>
<tr><th>Instalment</th><th>Amount</th><th>Due</th></tr>
<tr><td>1</td><td>&nbsp;</td><td>&nbsp;</td></tr>
<tr><td>2</td><td>&nbsp;</td><td>&nbsp;</td></tr>
<tr><td>3</td><td>&nbsp;</td><td>&nbsp;</td></tr>
</tbody></table>
<h2>Terms</h2>
<ul>
<li>Payment is due on the dates above. If I cannot pay on time, I will contact the clinic before the date rather than after it.</li>
<li>The clinic will issue a receipt for every payment.</li>
<li>If treatment is stopped part way through, I will be charged only for the work already carried out, and any balance will be refunded.</li>
<li>Insurance: where a third party is paying, I remain responsible for any amount the insurer declines.</li>
</ul>
<hr />
<p>{{clinic.name}} · {{clinic.address}} · {{clinic.phone}}</p>$en$,
$ar$<p><strong>{{patient.full_name}}</strong> · {{patient.phone}} · {{clinic.name}}</p>
<h2>المبلغ وجدول السداد</h2>
<p>إجمالي المبلغ المستحق مقابل العلاج المتّفق عليه هو <strong>{{service.price}}</strong>. وأوافق على سداده وفق الجدول المسجّل أدناه، المتّفق عليه مع العيادة بتاريخ {{today}}.</p>
<table><tbody>
<tr><th>القسط</th><th>المبلغ</th><th>تاريخ الاستحقاق</th></tr>
<tr><td>١</td><td>&nbsp;</td><td>&nbsp;</td></tr>
<tr><td>٢</td><td>&nbsp;</td><td>&nbsp;</td></tr>
<tr><td>٣</td><td>&nbsp;</td><td>&nbsp;</td></tr>
</tbody></table>
<h2>الشروط</h2>
<ul>
<li>يُستحق السداد في التواريخ أعلاه. وإذا تعذّر عليّ السداد في موعده، أتواصل مع العيادة قبل التاريخ لا بعده.</li>
<li>تُصدر العيادة إيصالاً لكل دفعة.</li>
<li>إذا توقّف العلاج في منتصفه، لا أُحاسَب إلا على ما نُفِّذ فعلاً، ويُرَد أي رصيد متبقٍّ.</li>
<li>التأمين: في حال كان طرف ثالث هو الجهة الدافعة، أبقى مسؤولاً عن أي مبلغ ترفضه شركة التأمين.</li>
</ul>
<hr />
<p>{{clinic.name}} · {{clinic.address}} · {{clinic.phone}}</p>$ar$,
  '{"mode":"sequential","signers":[{"role_key":"patient","required":true,"order":0},{"role_key":"clinic_representative","required":true,"order":1}]}',
  '[]'
),
------------------------------------------------------------------------ 5
(
  'privacy_notice',
  'Privacy notice and data consent',
  'إشعار الخصوصية والموافقة على استخدام البيانات',
  'privacy',
  50,
$en$<p><strong>{{clinic.name}}</strong> holds a medical record for <strong>{{patient.full_name}}</strong>. This notice explains what we hold, why, and what you can ask us to do.</p>
<h2>What we hold</h2>
<ul>
<li>Your name, date of birth, national ID and contact details.</li>
<li>Your clinical record: history, examinations, diagnoses, treatment, images and prescriptions.</li>
<li>Your appointments, invoices and payments.</li>
<li>Messages exchanged with the clinic, including on WhatsApp.</li>
</ul>
<h2>Why we hold it</h2>
<p>To care for you safely, to keep the records the law requires us to keep, to invoice you, and to contact you about your appointments and your treatment.</p>
<h2>Who sees it</h2>
<p>Only the clinic's own clinical and administrative staff, and any laboratory or specialist directly involved in your treatment. We do not sell your data and we do not share it for marketing.</p>
<h2>Your rights</h2>
<ul>
<li>To see your record and to receive a copy of it.</li>
<li>To have factual errors corrected.</li>
<li>To withdraw consent for non-essential contact, such as recall reminders, at any time.</li>
</ul>
<h2>Consent</h2>
<p>I confirm that this notice has been made available to me and I consent to {{clinic.name}} holding and using my data as described. I understand I may contact the clinic on {{clinic.phone}} about anything in it.</p>
<hr />
<p>{{today}}</p>$en$,
$ar$<p>تحتفظ <strong>{{clinic.name}}</strong> بسجل طبي خاص بـ<strong>{{patient.full_name}}</strong>. يوضّح هذا الإشعار ما نحتفظ به، ولماذا، وما يمكنك أن تطلبه منّا.</p>
<h2>ما نحتفظ به</h2>
<ul>
<li>اسمك وتاريخ ميلادك ورقمك الوطني وبيانات التواصل معك.</li>
<li>سجلك السريري: التاريخ المرضي والفحوص والتشخيصات والعلاج والصور والوصفات.</li>
<li>مواعيدك وفواتيرك ومدفوعاتك.</li>
<li>الرسائل المتبادلة مع العيادة، بما فيها رسائل واتساب.</li>
</ul>
<h2>لماذا نحتفظ به</h2>
<p>لرعايتك بأمان، وللاحتفاظ بالسجلات التي يُلزمنا القانون بحفظها، ولإصدار فواتيرك، ولمخاطبتك بشأن مواعيدك وعلاجك.</p>
<h2>من يراه</h2>
<p>موظفو العيادة السريريون والإداريون فقط، وأي مختبر أو أخصائي مشارك مباشرة في علاجك. نحن لا نبيع بياناتك ولا نشاركها لأغراض تسويقية.</p>
<h2>حقوقك</h2>
<ul>
<li>الاطلاع على سجلك والحصول على نسخة منه.</li>
<li>تصحيح أي خطأ واقعي فيه.</li>
<li>سحب موافقتك على التواصل غير الضروري، مثل تذكيرات المراجعة، في أي وقت.</li>
</ul>
<h2>الموافقة</h2>
<p>أؤكّد أن هذا الإشعار أُتيح لي، وأوافق على احتفاظ {{clinic.name}} ببياناتي واستخدامها كما هو موضّح. وأدرك أنه يمكنني التواصل مع العيادة على الرقم {{clinic.phone}} بشأن أي بند فيه.</p>
<hr />
<p>{{today}}</p>$ar$,
  '{"mode":"sequential","signers":[{"role_key":"patient","required":true,"order":0}]}',
  '[]'
),
------------------------------------------------------------------------ 6
(
  'media_consent',
  'Consent to clinical photography',
  'موافقة على التصوير السريري',
  'consent',
  60,
$en$<p>I, <strong>{{patient.full_name}}</strong>, agree that <strong>{{clinic.name}}</strong> may take clinical photographs or scans of my treatment.</p>
<h2>How they may be used</h2>
<p>Please indicate below which uses you agree to. You may agree to some and not others, and treatment does not depend on any of them.</p>
<ul>
<li><strong>My record</strong> — kept in my file to plan and compare treatment. This is part of ordinary clinical care.</li>
<li><strong>Teaching</strong> — shown to clinical colleagues or students, with identifying features removed.</li>
<li><strong>The clinic's own channels</strong> — website or social media, only with my separate agreement below.</li>
</ul>
<h2>Withdrawal</h2>
<p>I may withdraw consent for teaching or public use at any time by telling the clinic on {{clinic.phone}}. Images already published may not be recoverable, but nothing further will be used.</p>
<hr />
<p>{{clinic.name}} — {{today}}</p>$en$,
$ar$<p>أنا، <strong>{{patient.full_name}}</strong>، أوافق على أن تلتقط <strong>{{clinic.name}}</strong> صوراً سريرية أو أشعّة لعلاجي.</p>
<h2>كيف يمكن استخدامها</h2>
<p>يرجى تحديد الاستخدامات التي توافق عليها أدناه. يمكنك الموافقة على بعضها دون غيرها، والعلاج لا يتوقّف على أي منها.</p>
<ul>
<li><strong>سجلي</strong> — تُحفظ في ملفي لتخطيط العلاج ومقارنته. وهذا جزء من الرعاية السريرية المعتادة.</li>
<li><strong>التعليم</strong> — تُعرض على زملاء سريريين أو طلبة، بعد إزالة ما يدل على هويتي.</li>
<li><strong>قنوات العيادة</strong> — الموقع الإلكتروني أو وسائل التواصل، وذلك فقط بموافقتي المنفصلة أدناه.</li>
</ul>
<h2>سحب الموافقة</h2>
<p>يمكنني سحب الموافقة على الاستخدام التعليمي أو العام في أي وقت بإبلاغ العيادة على الرقم {{clinic.phone}}. وقد لا يمكن استرجاع الصور المنشورة سابقاً، لكن لن يُستخدم أي شيء بعد ذلك.</p>
<hr />
<p>{{clinic.name}} — {{today}}</p>$ar$,
  '{"mode":"sequential","signers":[{"role_key":"patient","required":true,"order":0}]}',
  '[{"key":"use_record","label":"Keep in my clinical record","label_ar":"الاحتفاظ بها في سجلي السريري","type":"checkbox","required":false,"options":[],"roles":["patient"]},{"key":"use_teaching","label":"May be used for teaching","label_ar":"يمكن استخدامها للتعليم","type":"checkbox","required":false,"options":[],"roles":["patient"]},{"key":"use_public","label":"May be used on the clinic''s website or social media","label_ar":"يمكن استخدامها على موقع العيادة أو وسائل التواصل","type":"checkbox","required":false,"options":[],"roles":["patient"]}]'
)
on conflict (key) do nothing;

-- Every clinic that already exists gets the library too, so this is not a
-- feature only new clinics have.
do $$
declare cl record; lt record; owner_id uuid;
begin
  for cl in select id from clinics loop
    select user_id into owner_id from clinic_members
      where clinic_id = cl.id and role = 'owner' and active order by created_at limit 1;
    for lt in select * from document_template_library where active order by sort loop
      if not exists (
        select 1 from document_templates t where t.clinic_id = cl.id and t.library_key = lt.key
      ) then
        insert into document_templates
          (clinic_id, name, name_ar, category, body, body_ar, language, signer_config,
           fields_schema, library_key, created_by)
        values
          (cl.id, lt.name, lt.name_ar, lt.category, lt.body, lt.body_ar, 'both',
           lt.signer_config, lt.fields_schema, lt.key, owner_id);
      end if;
    end loop;
  end loop;
end $$;
