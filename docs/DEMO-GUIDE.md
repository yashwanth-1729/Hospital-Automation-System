# DemoCare Hospital: what it is, and how to test every flow

Live site: **https://democare.tail349a3d.ts.net**
Patient form: `/enquiry` · Staff sign-in: `/login`

## What this is, in plain words

A hospital loses patients when messages go unanswered, appointments are missed, and the front desk is
chaotic. This product fixes both halves of that:

1. **It talks to patients on WhatsApp for you.** A patient sends an enquiry; the system understands it,
   books a slot, confirms on WhatsApp, reminds them, chases the ones who do not turn up, and follows up
   after discharge.
2. **It runs the hospital day.** Front desk and queue, the doctor's consultation and prescription, the
   pharmacy, billing and payments, ward beds, and management figures. Each step feeds the next, and every
   action carries the name of the person who did it.

Everything runs on our own server. Patient messages use fixed, Meta-approved wording; nothing a patient
reads is invented by an AI. Emergencies and medical questions are always handed to a person.

## Before you start

- **Real WhatsApp only goes to one number: 9052996536** (the Meta test number can message approved
  phones only). Use that number for every test where you want to see a message arrive.
- **Use separate windows for separate people.** Signing in as a second user in the same browser replaces
  the first. Use a normal window, a private window, and a second browser profile.
- Logins (demo accounts):

| Role | Email | Password |
|---|---|---|
| Administrator | admin@135-125-222-22.sslip.io | KpHGxE2ESpCYYpbE (asks you to set your own) |
| Receptionist | reception@democare.test | cddqAC5rSWP9rQt9 |
| Nurse | nurse@democare.test | T5NW3t3kqymhBS2Y |
| Doctor (Dr. Ananya Rao) | doctor@democare.test | kvyBpkNnbabty7Dg |
| Pharmacist | pharmacy@democare.test | Dn3Y2M32aySZzAfV |
| Billing | billing@democare.test | HcbPPPm9rcxAUda2 |

- If a WhatsApp message does not arrive: the Meta token may have expired (it lasts 24 hours unless a
  permanent one was made), or the number is not 9052996536. The **Exceptions** page shows what failed.

---

## The story to follow (about 20 minutes)

Do the flows in this order. Each uses what the previous one created.

### 1. Look around first (Administrator)
Sign in as the administrator. Open, in order:
- **Dashboard**: today's enquiries, bookings, people who need a person, no-shows.
- **Analytics**: patients per day, waiting time, money collected, busiest doctors, common diagnoses,
  medicines dispensed, bed occupancy. This is three weeks of fictional history.
- **Wards**: the bed board, with five current inpatients and a bed being cleaned.
- **Billing**: today's collections, outstanding, unpaid invoices.

*What it proves: the system holds a working hospital's data and management sees it live.*

### 2. A patient enquires on the website
Open `/enquiry` in a private window (this is what a patient sees).
- Name: your name. Mobile: **9052996536**. Department: Cardiology. Date: tomorrow. Message: "I would like
  to book a heart check-up." Leave the consent box ticked. Press **Request appointment**.
- **You should see:** a thank-you with a reference.
- **Within about 20 seconds:** a WhatsApp confirmation arrives with doctor, time and booking ID.
- **In the staff view:** *Enquiries* shows the lead as **Booked** with a full timeline; *Appointments*
  shows the booking with reminder times (24 hours and 3 hours before).

Try three variations (same number):
- **Emergency:** "severe chest pain and difficulty breathing". The patient is told to call 108, nothing is
  booked, and a high-priority task appears in **Exceptions**.
- **A medical question:** "what dose of metformin should I take?" No booking; it goes to a person.
- **Untick the consent box:** nothing is sent, and a task is opened to phone the patient instead.

### 3. Front desk registers the patient (Receptionist)
Sign in as the receptionist, open **Reception**, press **Register patient**.
- Name: the same name. Mobile: **9052996536** (the system recognises the existing patient and fills only
  the blanks, so no duplicate). Gender, age. **Known allergies: Penicillin.**
  **WhatsApp updates: Yes.** Doctor: **Dr. Ananya Rao**. Register.
- **You should see:** the patient in the doctor's queue with **token 1** (or the next number) and a red
  allergy line.
- Also try: **Urgent** (moves them to the front) and **Remove**.
- **Expected today** lists booked patients; **Check in** gives an appointment patient a token and marks
  them attended.

### 4. The nurse takes vitals (Nurse)
Sign in as the nurse, open **Consultation**, open the patient, fill blood pressure, pulse, temperature,
weight and height, press **Record vitals**. Try pulse 900: it is rejected with a reason.

### 5. The doctor consults (Doctor)
Sign in as the doctor, open **Consultation**, press **Call in**.
- Fill the reason for visit and the diagnosis.
- **Prescription:** type **Amoxicillin 500 mg**. The row turns red: *"allergic to penicillin"*, and a box
  asks why it is safe. Press **Finish consultation** without a reason: it refuses.
- Change the medicine to **Azithromycin 500 mg**, pick a follow-up date a week away, press **Finish
  consultation**.
- **Within about 20 seconds:** a WhatsApp "consultation complete, prescription ready at the pharmacy"
  arrives. A follow-up reminder is also scheduled for the day before the date you chose.
- Open the finished record: it is locked, and only dated addenda can be added.

### 6. The pharmacy dispenses (Pharmacist)
Sign in as the pharmacist. **Pharmacy** shows the prescription at the top.
- Open it: allergies and any doctor override are visible. Press **Dispense** (it offers what stock can fill).
- Open **Stock and receiving**: filters for **Low or out**, **Expiring soon** and **Expired** show the demo
  alerts. Try **Receive stock** (a new batch) and a correction with a reason.

### 7. Billing (Billing user)
Sign in as billing. **Billing** shows the patient under **Ready to bill**.
- **Create invoice**: consultation fee plus the medicine are already there. Add a service (for example
  ECG). Apply a **5%** discount with a reason; try **20%**: it needs an administrator.
- **Issue invoice**, then **Record payment** part by UPI, then the rest by cash.
- **You should see:** each payment gets a numbered receipt, and a WhatsApp receipt arrives.
- Try **Refund**, then **Print**, then open **Day book** for the day's totals by method.

### 8. A hospital stay (Receptionist or Nurse)
Open **Wards** > **Admit a patient**. Search the patient, pick a General Ward bed and Dr. Rao, admit.
- **Move to another bed** (an Intensive Care bed). The old bed shows **Cleaning**.
- **Discharge** with a follow-up date and approving doctor. The bed goes to cleaning, and a WhatsApp
  follow-up message arrives. A reminder and a feedback request are scheduled.
- Nurse: **Mark ready** on the cleaning bed. Billing: on the admission, **Create invoice for the stay**:
  bed charges per day, with the transfer day charged once.

### 9. After the visit (Receptionist or Administrator)
- **Appointments:** mark the booked appointment **No-show**. The recovery workflow starts (a polite
  rebooking message after a short delay, a second follow-up, then a task for staff).
- **Follow-ups**, **Discharges**, **Feedback**: lists of everyone being chased, with a one-time rating link
  for patients and a service-recovery task for low ratings.
- **Exceptions:** every task the system would not decide alone, with an owner and a due time.

### 10. Management and control (Administrator)
- **Reports:** conversion, response times, performance by department and source.
- **Staff accounts:** add a person. The temporary password shows once. Change a role, reset a password,
  deactivate (they are signed out instantly). The last administrator cannot be removed.
- **Audits:** the sales tool that scores a hospital's current process and prints a report.

### 11. Show that people only see their own area
- Sign in as the nurse and open **Reports** by typing `/reports`: "You do not have access".
- Enter a wrong password five times: the account locks for 15 minutes.
- Every change is recorded under the name of the person who made it.

---

## Things you cannot wait for live (say these, do not wait)
- The **24-hour and 3-hour appointment reminders** and the **day-before follow-up reminder** run on
  schedule. Show the scheduled times on the Appointments page.
- The **feedback request** goes out two days after discharge.
- The **no-show recovery message** goes out about 30 minutes after a miss.
  (These waits are settings; they can be shortened for a demo on request.)

## If something looks wrong
| Symptom | Likely cause |
|---|---|
| No WhatsApp arrives | Token expired, number is not 9052996536, or patient has no consent. See **Exceptions**. |
| A page says "no access" | You are signed in as the wrong role. |
| Site does not open | Tell the developer; the server restarts by itself and the address does not change. |

## Resetting the demo
Everything you create while testing stays. To go back to the clean demo hospital, ask the developer to run
the demo reset (it rebuilds the month of history and the live morning).
