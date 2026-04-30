import React, { useState, useEffect } from "react";
import { Card, Spinner, Badge, Table } from "react-bootstrap";
import { useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import toast from "react-hot-toast";
import { getToken, getUser } from "../utils/auth";
import { getDirectFileUrl } from "../utils/fileUrl";

const ReviewSubmissions = () => {
    const PAGE_LOADING_FALLBACK_MS = 5000;
    const location = useLocation();
    const navigate = useNavigate();
    const queryParams = new URLSearchParams(location.search);
    const assignmentId = queryParams.get("assignmentId");

    const [submissions, setSubmissions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [evaluating, setEvaluating] = useState(false);
    const [queueEvaluating, setQueueEvaluating] = useState(false);
    const [publishing, setPublishing] = useState(false);
    const [evaluationResult, setEvaluationResult] = useState(null);
    const [classroomId, setClassroomId] = useState(null);
    const [loadError, setLoadError] = useState("");

    const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;
    const token = getToken();
    const user = getUser();

    useEffect(() => {
        let isMounted = true;
        let loadingFallbackTimer = null;

        const clearLoadingFallbackTimer = () => {
            if (loadingFallbackTimer) {
                clearTimeout(loadingFallbackTimer);
                loadingFallbackTimer = null;
            }
        };

        if (user?.role !== 'teacher') {
            toast.error('Teachers only');
            setLoading(false);
            navigate('/');
            return () => {
                isMounted = false;
                clearLoadingFallbackTimer();
            };
        }

        if (!assignmentId) {
            setLoadError("Missing assignment ID.");
            setLoading(false);
            return () => {
                isMounted = false;
                clearLoadingFallbackTimer();
            };
        }

        if (assignmentId) {
            const fetchSubmissions = async () => {
                loadingFallbackTimer = setTimeout(() => {
                    if (!isMounted) return;
                    console.warn("[ReviewSubmissions] Loading fallback triggered after 5 seconds");
                    setLoading(false);
                }, PAGE_LOADING_FALLBACK_MS);
                try {
                    setLoadError("");
                    console.log("[ReviewSubmissions] Fetching assignment metadata", { assignmentId });
                    const assignmentRes = await axios.get(`${BACKEND_URL}/assignment/item/${assignmentId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                        timeout: 20000,
                        skipGlobalLoader: true,
                    });
                    if (!isMounted) return;
                    console.log("[ReviewSubmissions] Assignment metadata response received", { status: assignmentRes.status });
                    setClassroomId(assignmentRes.data?.assignment?.classroom || null);

                    console.log("[ReviewSubmissions] Fetching submissions", { assignmentId });
                    const response = await axios.get(`${BACKEND_URL}/submission/assignment/${assignmentId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                        timeout: 20000,
                        skipGlobalLoader: true,
                    });
                    if (!isMounted) return;
                    console.log("[ReviewSubmissions] Submissions response received", {
                        status: response.status,
                        count: response.data?.submissions?.length || 0,
                    });
                    setSubmissions(response.data.submissions);
                } catch (err) {
                    if (!isMounted) return;
                    const message = err?.response?.data?.message || "Failed to fetch submissions";
                    setLoadError(message);
                    toast.error(message);
                } finally {
                    clearLoadingFallbackTimer();
                    if (isMounted) {
                        setLoading(false);
                    }
                }
            };
            fetchSubmissions();
        }

        return () => {
            isMounted = false;
            clearLoadingFallbackTimer();
        };
    }, [assignmentId, BACKEND_URL, token, user?.role, navigate]);

    const refreshSubmissions = async () => {
        if (!assignmentId) return;
        try {
            console.log("[ReviewSubmissions] Refreshing submissions", { assignmentId });
            const response = await axios.get(`${BACKEND_URL}/submission/assignment/${assignmentId}`, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 20000,
                skipGlobalLoader: true,
            });
            console.log("[ReviewSubmissions] Refresh response received", {
                status: response.status,
                count: response.data?.submissions?.length || 0,
            });
            setSubmissions(response.data.submissions);
            setLoadError("");
        } catch (err) {
            const message = err?.response?.data?.message || "Failed to refresh submissions";
            setLoadError(message);
            throw err;
        }
    };

    const openSubmissionFile = (rawUrl) => {
        const fileUrl = getDirectFileUrl(rawUrl);
        if (!fileUrl) {
            toast.error("Invalid submission file URL. Ask the student to re-upload.");
            return;
        }

        const openedWindow = window.open(fileUrl, "_blank", "noopener,noreferrer");
        if (!openedWindow) {
            toast.error("Unable to open file. Please allow pop-ups in your browser.");
        }
    };

    const handleEvaluate = async (submission) => {
        setEvaluating(true);
        try {
            console.log("[ReviewSubmissions] Starting AI evaluation", { submissionId: submission._id });
            const response = await axios.post(
                `${BACKEND_URL}/submission/evaluate-ai/${submission._id}`,
                {},
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                    timeout: 45000,
                    skipGlobalLoader: true,
                }
            );
            console.log("[ReviewSubmissions] AI evaluation response received", {
                submissionId: submission._id,
                status: response.status,
            });

            toast.success("AI grading completed");
            setEvaluationResult(response.data.submission);
            await refreshSubmissions();
        } catch (err) {
            console.error("[ReviewSubmissions] AI evaluation failed", {
                submissionId: submission._id,
                message: err?.response?.data?.message || err.message,
            });
            toast.error(err?.response?.data?.message || "Evaluation failed");
        } finally {
            setEvaluating(false);
        }
    };

    const handleEvaluateNext = async () => {
        if (!classroomId) {
            toast.error('Missing classroomId');
            return;
        }
        setQueueEvaluating(true);
        try {
            console.log("[ReviewSubmissions] Starting queue evaluation", { classroomId });
            const res = await axios.post(
                `${BACKEND_URL}/submission/evaluate-next`,
                { classroomId },
                { headers: { Authorization: `Bearer ${token}` }, timeout: 45000, skipGlobalLoader: true }
            );
            console.log("[ReviewSubmissions] Queue evaluation response received", {
                classroomId,
                status: res.status,
                hasSubmission: !!res.data?.submission,
            });

            if (!res.data?.submission) toast.success('No pending submissions');
            else toast.success('Evaluated next submission');

            await refreshSubmissions();
        } catch (err) {
            console.error("[ReviewSubmissions] Queue evaluation failed", {
                classroomId,
                message: err?.response?.data?.message || err.message,
            });
            toast.error(err?.response?.data?.message || 'Queue evaluation failed');
        } finally {
            setQueueEvaluating(false);
        }
    };

    const handlePublish = async () => {
        if (!classroomId) {
            toast.error('Missing classroomId');
            return;
        }
        setPublishing(true);
        try {
            console.log("[ReviewSubmissions] Publishing results", { classroomId });
            const res = await axios.post(
                `${BACKEND_URL}/submission/publish`,
                { classroomId },
                { headers: { Authorization: `Bearer ${token}` }, timeout: 30000, skipGlobalLoader: true }
            );
            console.log("[ReviewSubmissions] Publish response received", {
                classroomId,
                status: res.status,
                modifiedCount: res.data?.modifiedCount || 0,
            });
            toast.success(`Published ${res.data?.modifiedCount || 0} results`);
            await refreshSubmissions();
        } catch (err) {
            console.error("[ReviewSubmissions] Publish failed", {
                classroomId,
                message: err?.response?.data?.message || err.message,
            });
            toast.error(err?.response?.data?.message || 'Publish failed');
        } finally {
            setPublishing(false);
        }
    };

    if (loading) return <div className="gc-center"><Spinner animation="border" variant="primary" /></div>;

    return (
        <>
            <div className="gc-page-wide" style={{ paddingTop: "88px" }}>
                <div style={{ marginBottom: "24px" }}>
                    <button className="gc-btn gc-btn-secondary mb-3" onClick={() => navigate(-1)}>← Back</button>
                    <h2 style={{ fontSize: "1.5rem", fontWeight: 500 }}>Review Submissions</h2>
                    <p style={{ color: "var(--gc-text-secondary)" }}>Manage student hand-ins and use AI to grade</p>
                </div>

                <div className="row">
                    <div className="col-md-4">
                        <Card className="gc-card" style={{ padding: "20px" }}>
                            <h4 style={{ fontSize: "1rem", marginBottom: "16px" }}>AI Evaluation</h4>
                            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                                <button
                                    className="gc-btn gc-btn-primary"
                                    onClick={handleEvaluateNext}
                                    disabled={queueEvaluating || !classroomId}
                                >
                                    {queueEvaluating ? 'Evaluating…' : 'Start AI Evaluation (Next in Queue)'}
                                </button>

                                <button
                                    className="gc-btn gc-btn-secondary"
                                    onClick={handlePublish}
                                    disabled={publishing || !classroomId}
                                >
                                    {publishing ? 'Publishing…' : 'Publish Results'}
                                </button>
                            </div>

                            <div style={{ background: "var(--gc-blue-light)", padding: "12px", borderRadius: "8px", fontSize: "12px", color: "var(--gc-blue)", marginTop: "14px" }}>
                                AI grading runs one submission at a time and stores feedback.
                                Results stay hidden until you click Publish.
                            </div>
                        </Card>
                    </div>
                    <div className="col-md-8">
                        <Card className="gc-card" style={{ padding: "0", overflow: "hidden" }}>
                            {loadError && (
                                <div style={{ padding: "12px 16px", background: "var(--gc-red-light)", color: "var(--gc-red)", fontSize: "13px" }}>
                                    Failed to load submissions: {loadError}
                                </div>
                            )}
                            <Table hover responsive style={{ margin: 0 }}>
                                <thead style={{ background: "var(--gc-bg)" }}>
                                    <tr>
                                        <th style={{ padding: "16px" }}>Student</th>
                                        <th>Submitted On</th>
                                        <th>Status</th>
                                        <th>Marks</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {submissions.length === 0 ? (
                                        <tr>
                                            <td colSpan="5" className="text-center p-4 text-muted">No submissions yet</td>
                                        </tr>
                                    ) : (
                                        submissions.map(s => (
                                            <tr key={s._id}>
                                                <td style={{ padding: "16px" }}>{s.student?.name || 'Unknown'}</td>
                                                <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                                                <td>
                                                    <Badge bg={s.isPublished ? "primary" : (s.isEvaluated || s.evaluated) ? "success" : "warning"}>
                                                        {s.isPublished ? "Published" : (s.isEvaluated || s.evaluated) ? "Evaluated" : "Pending"}
                                                    </Badge>
                                                </td>
                                                <td>{(s.isEvaluated || s.evaluated) ? `${(s.aiScore ?? s.marks)}/10` : '-'}</td>
                                                <td>
                                                    {(s.fileUrl || s.solutionFileURL) && (
                                                        <button
                                                            className="gc-btn gc-btn-text"
                                                            style={{ padding: "4px 8px", marginRight: "6px" }}
                                                            onClick={() => openSubmissionFile(s.fileUrl || s.solutionFileURL)}
                                                        >
                                                            View File
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </Table>
                        </Card>

                        {evaluationResult && (
                            <Card className="gc-card" style={{ marginTop: "16px", padding: "16px" }}>
                                <h5 style={{ marginBottom: "8px" }}>Latest AI Result</h5>
                                <div style={{ fontSize: "13px", color: "var(--gc-text-secondary)" }}>
                                    Marks: <strong style={{ color: "var(--gc-text-primary)" }}>{(evaluationResult.aiScore ?? evaluationResult.marks)}/10</strong>
                                </div>
                                {Array.isArray(evaluationResult.feedback) && evaluationResult.feedback.length > 0 && (
                                    <div style={{ marginTop: "10px", fontSize: "13px" }}>
                                        {evaluationResult.feedback.map((f, idx) => (
                                            <div key={idx} style={{ padding: "6px 0", borderBottom: idx < evaluationResult.feedback.length - 1 ? "1px solid var(--gc-border-light)" : "none" }}>
                                                {f}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </Card>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
};

export default ReviewSubmissions;
