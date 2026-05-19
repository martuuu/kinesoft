Fetch this design file, read its readme, and implement the relevant aspects of the design. https://api.anthropic.com/v1/design/h/_mQ2sIuTBTHw_u9_18Ogtg?open_file=index.html
Implement:Here is the highly optimized, technical translation tailored specifically for an AI coding agent like Claude Code. It uses standard software engineering nomenclature to ensure the LLM understands architecture, infrastructure, and domain-specific business logic patterns.

---

## Technical Context Prompt for Claude Code

### Role & Tech Stack

Act as an expert **Fullstack Software Engineer**. You will build an enterprise-grade web application from the ground up based on an existing UI design system.

* **Tech Stack:** Next.js (App Router), Supabase, TypeScript, Prisma ORM, PostgreSQL, React, and Tailwind CSS.
* **Initial Objective:** Set up the repository, configure the development environment, and architect a highly scalable **multi-tenant SaaS structure** right from the root configuration.

---

### UI/UX & Component Requirements

* **Design Fidelity:** Implement the provided design with maximum fidelity, adhering strictly to modern UI/UX best practices. Programmatically fix any minor alignment, spacing, or visual inconsistencies in the layout.
* **The "Tweeks" Component:** Retain the current design as it works perfectly, but refactor it to include a toggle to minimize/collapse the component.
* **Public & Private Booking Systems (Turneros):**
* The **Public Landing/Marketing page** is finalized; implement it exactly as designed.
* The **Private Booking System** requires functional enhancement: Integrate **Google OAuth** for patient authentication and implement a complete server-to-client **Mercado Pago payment gateway API integration** to allow automated booking confirmations upon successful payment.


* **Component Architecture:** Componentize and refactor the entire UI layout to ensure a clean, dry, and scalable architecture, optimizing for reusability where appropriate.

---

### Responsiveness & Layout Strategy

The application architecture follows a **Desktop-First** approach for the internal administrative tooling, with targeted mobile viewports:

* **Mobile-Ready Views:** The Marketing Landing page, Private Booking system, and the Patient Portal (Patient Profile) must be fully responsive (**Mobile-First/Mobile-Ready**) with a clean, lightweight, and minimal data footprint.
* **Admin/Practitioner Views:** Full mobile feature parity is not required for complex medical modules. For example, instead of mimicking the desktop layout of the **Diagnosis page** on mobile, implement an alternative, simplified **Step-by-Step mobile workflow Wizard**.

---

### Database Schema & Business Logic (Kinesiology Niche)

Analyze and audit the system requirements from the perspective of a health professional, specifically optimized for **Physical Therapists / Kinesiologists**. Generate a robust **Prisma Schema for PostgreSQL** to back a concrete MVP.

The core intellectual property and complex business logic reside within the new **Diagnosis Module**:

#### Feature Specification: Diagnosis Page

> **Core Concept:** This module must function completely **patient-agnostic** during the initial matching phase. It allows the physical therapist to map localized pain areas to prospective clinical pathologies and exercise treatments.
> **Data Modeling & Matching Engine:**
> * Design a scalable database schema supporting a multi-level **tagging and sub-tagging system** for conditions and pathologies.
> * **Example Workflow:** Selecting "Ankle" drills down into specific anatomical sub-regions and associated clinical conditions, generating automated diagnostic suggestions.
> * **Cross-Functional Mapping (Indirect Kinematic Chains):** The matching algorithm must account for indirect physiological relationships. For instance, *Iliotibial Band Syndrome (ITBS)* must surface glute activation exercises (not just direct knee rehab), or *bicep tendinopathy* might suggest core/abdominal stabilization routines.
> 
> 
> **Patient Assignment Workflow:**
> Once the practitioner confirms a diagnosis and generates the corresponding recovery session, provide a clear action item (e.g., a button) to dynamically assign this output to a specific patient's Electronic Health Record (EHR).
> **Session Program Builder:**
> Lay the database and UI foundation to compile these diagnostic results into a multi-week **Treatment Program** containing the recommended exercises. This feature should be accessible as a reusable **Session Plan Creator Modal** embedded within the patient's clinical history timeline for quick deployment.
> *Note: Build this schema manually with strict relations, as it will later serve as the context baseline for an AI-assisted diagnostic override engine.*