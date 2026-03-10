import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Edit2, Lock, Mail, Plus, Save, Shield, Trash2, Unlock, User } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import {
    clearAuthSession,
    getApiBaseUrl,
    getAuthHeaders,
    getStoredUser,
    updateStoredUser,
} from '../apiConfig';

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_EMAIL = 'admin@gmail.com';

const isDefaultAdmin = (user) => (
    (user?.username || '') === DEFAULT_ADMIN_USERNAME && (user?.email || '') === DEFAULT_ADMIN_EMAIL
);

const formatRoleLabel = (role) => {
    if (!role) return 'Staff';
    const normalized = String(role).toLowerCase();
    if (normalized === 'admin') return 'Admin';
    return 'Staff';
};

const emptyProfileState = {
    username: '',
    email: '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
};

const emptyUserForm = {
    username: '',
    email: '',
    role: 'staff',
    password: '',
};

const AccountSettings = () => {
    const apiUrl = getApiBaseUrl();
    const navigate = useNavigate();

    const [activeTab, setActiveTab] = useState('profile');
    const [isUnlocked, setIsUnlocked] = useState(false);
    const [unlockPassword, setUnlockPassword] = useState('');
    const [unlockError, setUnlockError] = useState('');

    const [meUser, setMeUser] = useState(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [formData, setFormData] = useState(emptyProfileState);
    const [initialProfile, setInitialProfile] = useState(emptyProfileState);
    const [profileSaving, setProfileSaving] = useState(false);
    const [profileMessage, setProfileMessage] = useState('');

    const [users, setUsers] = useState([]);
    const [usersLoading, setUsersLoading] = useState(false);
    const [userSaveError, setUserSaveError] = useState('');
    const [isUserModalOpen, setIsUserModalOpen] = useState(false);
    const [editingUser, setEditingUser] = useState(null);
    const [userForm, setUserForm] = useState(emptyUserForm);

    const handle401 = useCallback(() => {
        clearAuthSession();
        navigate('/login');
    }, [navigate]);

    const fetchMe = useCallback(async () => {
        const response = await fetch(`${apiUrl}/api/users/me`, {
            headers: getAuthHeaders(),
        });
        if (response.status === 401) {
            handle401();
            return null;
        }
        if (!response.ok) {
            return null;
        }
        return response.json();
    }, [apiUrl, handle401]);

    const fetchUsers = useCallback(async () => {
        setUsersLoading(true);
        try {
            const response = await fetch(`${apiUrl}/api/users`, {
                headers: getAuthHeaders(),
            });
            if (response.status === 401) {
                handle401();
                return;
            }
            if (!response.ok) {
                const fallbackUser = meUser || getStoredUser();
                setUsers(fallbackUser ? [fallbackUser] : []);
                return;
            }

            const data = await response.json().catch(() => []);
            setUsers(Array.isArray(data) ? data : []);
        } catch {
            const fallbackUser = meUser || getStoredUser();
            setUsers(fallbackUser ? [fallbackUser] : []);
        } finally {
            setUsersLoading(false);
        }
    }, [apiUrl, handle401, meUser]);

    useEffect(() => {
        fetchMe().then((me) => {
            if (!me) {
                return;
            }

            setMeUser(me);
            setIsAdmin(me.role === 'admin');

            const nextProfile = {
                username: me.username || '',
                email: me.email || '',
                currentPassword: '',
                newPassword: '',
                confirmPassword: '',
            };
            setFormData(nextProfile);
            setInitialProfile(nextProfile);
        });
    }, [fetchMe]);

    useEffect(() => {
        if (isUnlocked && activeTab === 'users') {
            fetchUsers();
        }
    }, [activeTab, fetchUsers, isUnlocked]);

    const handleProfileChange = (event) => {
        const { name, value } = event.target;
        setFormData((current) => ({ ...current, [name]: value }));
    };

    const handleUserFormChange = (event) => {
        const { name, value } = event.target;
        setUserForm((current) => ({ ...current, [name]: value }));
    };

    const handleUnlock = async (event) => {
        event.preventDefault();
        setUnlockError('');

        const stored = getStoredUser();
        const identifier = stored?.username || stored?.email;
        if (!identifier) {
            setUnlockError('Session expired. Please sign in again.');
            return;
        }

        try {
            const response = await fetch(`${apiUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(
                    identifier.includes('@')
                        ? { email: identifier, password: unlockPassword }
                        : { username: identifier, password: unlockPassword }
                ),
            });
            if (!response.ok) {
                setUnlockError('Invalid password.');
                return;
            }

            const data = await response.json().catch(() => ({}));
            if (data?.user?.role !== 'admin') {
                setUnlockError('Only admin users can access User Management.');
                return;
            }

            setUnlockPassword('');
            setIsUnlocked(true);
        } catch {
            setUnlockError('Network error.');
        }
    };

    const handleProfileSubmit = async (event) => {
        event.preventDefault();
        setProfileMessage('');

        if (isDefaultAdmin(meUser)) {
            setProfileMessage('Default admin user cannot be modified.');
            setFormData({ ...initialProfile });
            return;
        }
        if (formData.newPassword && formData.newPassword !== formData.confirmPassword) {
            setProfileMessage('New passwords do not match.');
            return;
        }
        if (formData.newPassword.trim() && !formData.currentPassword.trim()) {
            setProfileMessage('Please enter your current password.');
            return;
        }

        setProfileSaving(true);
        try {
            const body = {
                username: formData.username,
                email: formData.email || null,
            };
            if (formData.newPassword.trim()) {
                body.password = formData.newPassword;
                body.current_password = formData.currentPassword;
            }

            const response = await fetch(`${apiUrl}/api/users/me`, {
                method: 'PUT',
                headers: getAuthHeaders(),
                body: JSON.stringify(body),
            });
            if (response.status === 401) {
                handle401();
                return;
            }

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                setProfileMessage(data.detail || 'Update failed.');
                return;
            }

            updateStoredUser(data);
            setMeUser(data);
            setIsAdmin(data.role === 'admin');

            const nextProfile = {
                username: data.username || '',
                email: data.email || '',
                currentPassword: '',
                newPassword: '',
                confirmPassword: '',
            };
            setFormData(nextProfile);
            setInitialProfile(nextProfile);
            setProfileMessage('Profile updated successfully.');
        } catch {
            setProfileMessage('Network error.');
        } finally {
            setProfileSaving(false);
        }
    };

    const openAddUserModal = () => {
        setEditingUser(null);
        setUserForm(emptyUserForm);
        setUserSaveError('');
        setIsUserModalOpen(true);
    };

    const openEditUserModal = (user) => {
        setEditingUser(user);
        setUserForm({
            username: user.username || '',
            email: user.email || '',
            role: user.role || 'staff',
            password: '',
        });
        setUserSaveError('');
        setIsUserModalOpen(true);
    };

    const handleDeleteUser = async (user) => {
        if (isDefaultAdmin(user)) {
            setUserSaveError('Default admin user cannot be deleted.');
            return;
        }
        if (!window.confirm('Are you sure you want to delete this user?')) {
            return;
        }

        try {
            const response = await fetch(`${apiUrl}/api/users/${user.id}`, {
                method: 'DELETE',
                headers: getAuthHeaders(),
            });
            if (response.status === 401) {
                handle401();
                return;
            }

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                setUserSaveError(data.detail || 'Failed to delete user.');
                return;
            }

            await fetchUsers();
        } catch {
            setUserSaveError('Failed to delete user.');
        }
    };

    const handleSaveUser = async (event) => {
        event.preventDefault();
        setUserSaveError('');

        if (!editingUser && !userForm.password.trim()) {
            setUserSaveError('Password is required for new users.');
            return;
        }

        try {
            const isEditing = Boolean(editingUser);
            const url = isEditing ? `${apiUrl}/api/users/${editingUser.id}` : `${apiUrl}/api/users`;
            const body = {
                username: userForm.username,
                email: userForm.email || null,
                role: userForm.role,
            };
            if (userForm.password.trim()) {
                body.password = userForm.password;
            }

            const response = await fetch(url, {
                method: isEditing ? 'PUT' : 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(body),
            });
            if (response.status === 401) {
                handle401();
                return;
            }

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                setUserSaveError(data.detail || (isEditing ? 'Update failed.' : 'Create failed.'));
                return;
            }

            setIsUserModalOpen(false);
            setUserForm(emptyUserForm);
            await fetchUsers();
        } catch {
            setUserSaveError('Network error.');
        }
    };

    return (
        <div className="max-w-5xl mx-auto space-y-6">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Account Settings</h1>
                <p className="text-muted-foreground">Manage your profile and system users.</p>
            </div>

            <div className="flex space-x-1 rounded-lg bg-muted p-1 w-fit">
                <button
                    type="button"
                    onClick={() => setActiveTab('profile')}
                    className={`inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all ${activeTab === 'profile' ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                    My Profile
                </button>
                {isAdmin && (
                    <button
                        type="button"
                        onClick={() => setActiveTab('users')}
                        className={`inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all ${activeTab === 'users' ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                        User Management
                    </button>
                )}
            </div>

            {activeTab === 'profile' && (
                <Card>
                    <CardHeader>
                        <CardTitle>Profile Information</CardTitle>
                        <CardDescription>Update your account details and password.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleProfileSubmit} className="space-y-4">
                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Username</label>
                                    <div className="relative">
                                        <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <input
                                            type="text"
                                            name="username"
                                            value={formData.username}
                                            onChange={handleProfileChange}
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Email</label>
                                    <div className="relative">
                                        <Mail className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <input
                                            type="email"
                                            name="email"
                                            value={formData.email}
                                            onChange={handleProfileChange}
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm"
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="grid gap-4 md:grid-cols-3">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Current Password</label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <input
                                            type="password"
                                            name="currentPassword"
                                            value={formData.currentPassword}
                                            onChange={handleProfileChange}
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">New Password</label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <input
                                            type="password"
                                            name="newPassword"
                                            value={formData.newPassword}
                                            onChange={handleProfileChange}
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Confirm Password</label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                        <input
                                            type="password"
                                            name="confirmPassword"
                                            value={formData.confirmPassword}
                                            onChange={handleProfileChange}
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm"
                                        />
                                    </div>
                                </div>
                            </div>

                            {profileMessage && (
                                <p className={`text-sm ${profileMessage.includes('successfully') ? 'text-green-600' : 'text-destructive'}`}>
                                    {profileMessage}
                                </p>
                            )}

                            <div className="flex justify-end">
                                <Button type="submit" disabled={profileSaving}>
                                    <Save className="w-4 h-4 mr-2" />
                                    {profileSaving ? 'Saving...' : 'Save Changes'}
                                </Button>
                            </div>
                        </form>
                    </CardContent>
                </Card>
            )}

            {activeTab === 'users' && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div>
                            <CardTitle>User Management</CardTitle>
                            <CardDescription>Manage access and roles for other users.</CardDescription>
                        </div>
                        {isUnlocked && (
                            <Button type="button" onClick={openAddUserModal}>
                                <Plus className="w-4 h-4 mr-2" />
                                Add User
                            </Button>
                        )}
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {!isUnlocked ? (
                            <form onSubmit={handleUnlock} className="max-w-md space-y-4">
                                <p className="text-sm text-muted-foreground">
                                    Enter your password to manage other users.
                                </p>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                                    <input
                                        type="password"
                                        value={unlockPassword}
                                        onChange={(event) => setUnlockPassword(event.target.value)}
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pl-9 text-sm"
                                        placeholder="Enter password"
                                    />
                                </div>
                                {unlockError && <p className="text-sm text-destructive">{unlockError}</p>}
                                <Button type="submit" className="w-full">
                                    <Unlock className="w-4 h-4 mr-2" />
                                    Unlock User Management
                                </Button>
                            </form>
                        ) : usersLoading ? (
                            <p className="text-sm text-muted-foreground">Loading users...</p>
                        ) : (
                            <div className="rounded-md border overflow-hidden">
                                <table className="w-full text-sm">
                                    <thead className="bg-muted/50 border-b">
                                        <tr>
                                            <th className="h-12 px-4 text-left font-medium text-muted-foreground">Username</th>
                                            <th className="h-12 px-4 text-left font-medium text-muted-foreground">Email</th>
                                            <th className="h-12 px-4 text-left font-medium text-muted-foreground">Role</th>
                                            <th className="h-12 px-4 text-right font-medium text-muted-foreground">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {users.map((user) => (
                                            <tr key={user.id} className="border-b last:border-b-0 hover:bg-muted/40">
                                                <td className="p-4 align-middle font-medium">
                                                    <div className="flex items-center gap-2">
                                                        <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                                                            <User className="w-4 h-4" />
                                                        </div>
                                                        {user.username}
                                                    </div>
                                                </td>
                                                <td className="p-4 align-middle">{user.email || '-'}</td>
                                                <td className="p-4 align-middle">
                                                    <div className="flex items-center gap-1">
                                                        <Shield className="w-3 h-3 text-primary" />
                                                        {formatRoleLabel(user.role)}
                                                    </div>
                                                </td>
                                                <td className="p-4 align-middle">
                                                    <div className="flex justify-end gap-2">
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            onClick={() => {
                                                                if (isDefaultAdmin(user)) {
                                                                    setUserSaveError('Default admin user cannot be modified.');
                                                                    return;
                                                                }
                                                                openEditUserModal(user);
                                                            }}
                                                        >
                                                            <Edit2 className="w-4 h-4" />
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            className="text-destructive"
                                                            onClick={() => handleDeleteUser(user)}
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </Button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {userSaveError && (
                            <p className="text-sm text-destructive">{userSaveError}</p>
                        )}
                    </CardContent>
                </Card>
            )}

            {isUserModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                    <Card className="w-full max-w-md">
                        <CardHeader>
                            <CardTitle>{editingUser ? 'Edit User' : 'Add New User'}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <form onSubmit={handleSaveUser} className="space-y-4">
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Username</label>
                                    <input
                                        name="username"
                                        value={userForm.username}
                                        onChange={handleUserFormChange}
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        required
                                    />
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Email</label>
                                    <input
                                        type="email"
                                        name="email"
                                        value={userForm.email}
                                        onChange={handleUserFormChange}
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">Role</label>
                                    <select
                                        name="role"
                                        value={userForm.role}
                                        onChange={handleUserFormChange}
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    >
                                        <option value="admin">Admin</option>
                                        <option value="staff">Staff</option>
                                    </select>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-medium">
                                        {editingUser ? 'New Password (optional)' : 'Password'}
                                    </label>
                                    <input
                                        type="password"
                                        name="password"
                                        value={userForm.password}
                                        onChange={handleUserFormChange}
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        placeholder={editingUser ? 'Optional - leave empty to keep the current password' : ''}
                                        required={!editingUser}
                                    />
                                </div>

                                {userSaveError && <p className="text-sm text-destructive">{userSaveError}</p>}

                                <div className="flex justify-end gap-2">
                                    <Button type="button" variant="ghost" onClick={() => setIsUserModalOpen(false)}>
                                        Cancel
                                    </Button>
                                    <Button type="submit">Save User</Button>
                                </div>
                            </form>
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    );
};

export default AccountSettings;
