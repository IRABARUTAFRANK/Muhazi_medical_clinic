-- 0117 · Employee documents: opening the list writes the access log, so the function is not
-- read-only.
--
-- staff_documents() (0116) was declared `stable`; the API then calls it in a read-only
-- transaction, and its audit line (log_staff_document_access → audit_event) failed with
-- "cannot execute INSERT in a read-only transaction" the first time the manager opened an
-- employee's documents. The body is unchanged: only the volatility is corrected.

alter function staff_documents(uuid) volatile;
